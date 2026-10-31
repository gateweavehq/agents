import { env } from "cloudflare:workers";
import { TRIGGER_LIMITS, type TriggerReceipt } from "@gateweave/agents-model";
import { conversationName, type TriggerTurnOutcome } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { limitTriggerRequests } from "./rate-limit";
import { registryFor } from "./registry";
import { runsPage } from "./runs-page";

const ID = /^[\w-]{1,64}$/;

/**
 * The gateway to triggers: inbound webhooks that start a run of an agent or a team. Anyone may
 * post here, so nothing is trusted until the workspace's registry has checked the delivery's
 * Standard Webhooks signature with the trigger's secret. A workspace that does not exist is
 * turned away first, so no registry is made for it.
 *
 *   POST /api/triggers/:workspaceId/:triggerId
 *
 * The answer tells the sender whether to try again: 202 once the run has started (or for a
 * delivery whose run started before, or a paused trigger), 429 with `Retry-After` over a limit,
 * 409 when the agent cannot answer yet or the delivery's run is still starting, and 401 or 404 for
 * a delivery that is not for us.
 */
export async function receiveTrigger(
	request: Request,
	workspaceId: string,
	triggerId: string,
): Promise<Response> {
	const client = request.headers.get("cf-connecting-ip") ?? "unknown";
	const { allowed, retryAfter } = limitTriggerRequests(client);
	if (!allowed) {
		return reply(429, "Too many deliveries", { "Retry-After": String(retryAfter ?? 10) });
	}
	if (!ID.test(workspaceId) || !ID.test(triggerId)) return reply(404, "Trigger not found");
	const body = await readBody(request);
	if (body === null) return reply(413, "The body is too large");
	const id = request.headers.get("webhook-id");
	const timestamp = request.headers.get("webhook-timestamp");
	const signature = request.headers.get("webhook-signature");
	if (!id || !timestamp || !signature) return reply(401, "The delivery is not signed");

	const workspace = await db
		.select({ id: schema.organization.id, slug: schema.organization.slug })
		.from(schema.organization)
		.where(eq(schema.organization.id, workspaceId))
		.get();
	if (!workspace) return reply(404, "Trigger not found");
	const receipt = await registryFor(workspaceId).receiveTrigger(
		triggerId,
		{ id, timestamp, signature },
		body,
	);
	const runs = runsPage(workspace.slug, new URL(request.url).origin);
	return answer(workspaceId, runs, receipt);
}

async function answer(
	workspaceId: string,
	runs: string | null,
	receipt: TriggerReceipt,
): Promise<Response> {
	switch (receipt.status) {
		case "start":
			return start(workspaceId, receipt.conversationId, receipt.text, runs);
		case "duplicate":
			return Response.json({ runId: receipt.runId, duplicate: true }, { status: 202 });
		case "starting":
			return reply(409, "This delivery's run is starting; try again shortly", {
				"Retry-After": String(receipt.retryAfter),
			});
		case "skipped":
			return Response.json({ skipped: true }, { status: 202 });
		case "limited":
			return reply(429, receipt.message, { "Retry-After": String(receipt.retryAfter) });
		case "refused":
			return reply(409, receipt.message);
		case "unauthorized":
			return reply(401, "The signature does not match");
		case "not_found":
			return reply(404, "Trigger not found");
	}
}

/** Begins the run in the conversation the registry opened for the delivery. */
async function start(
	workspaceId: string,
	conversationId: string,
	text: string,
	runs: string | null,
) {
	let outcome: TriggerTurnOutcome;
	try {
		const conversation = await getAgentByName(
			env.CONVERSATIONS,
			conversationName(workspaceId, conversationId),
		);
		outcome = await conversation.triggerTurn(text, runs);
	} catch (error) {
		// The delivery stays taken for a minute, then a retry starts it again.
		console.error("triggers: a run could not be started", error);
		return reply(502, "The run could not be started");
	}
	if (outcome.runId === null) return reply(409, outcome.error);
	return Response.json({ runId: outcome.runId }, { status: 202 });
}

/** The body as text; null once it is larger than a trigger takes, without reading the rest. */
async function readBody(request: Request): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > TRIGGER_LIMITS.bodyBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function reply(status: number, error: string, headers: Record<string, string> = {}): Response {
	return Response.json({ error }, { status, headers });
}
