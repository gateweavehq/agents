import { eq } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { demoEnabled } from "./demo/mode";
import { limitTriggerRequests } from "./rate-limit";
import { findRegistry } from "./registry";
import { whoSentIt } from "./workers-address";

const ID = /^[\w-]{1,64}$/;
/** GitLab's push events list at most 20 commits; anything near this is not one. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The gateway to a GitLab connection's push webhook (AGT-79). Anyone may post here, so nothing is
 * read until the workspace's registry has checked the `X-Gitlab-Token` header against the
 * connection's secret token. A workspace that does not exist is turned away first, so no registry
 * is made for it, and a delivery that is not for us gets the same 404 as a missing connection.
 *
 *   POST /api/gitlab/webhooks/:workspaceId/:connectionId
 */
export async function receiveGitLabWebhook(
	request: Request,
	workspaceId: string,
	connectionId: string,
): Promise<Response> {
	// The public demo connects no GitLab, so nothing posts here for it.
	if (demoEnabled()) return reply(404, "Not found");
	// Inbound webhooks share one budget per sender.
	const { allowed, retryAfter } = limitTriggerRequests(whoSentIt(request));
	if (!allowed) {
		return reply(429, "Too many deliveries", { "Retry-After": String(retryAfter ?? 10) });
	}
	if (!ID.test(workspaceId) || !ID.test(connectionId)) return reply(404, "Not found");
	const secretToken = request.headers.get("x-gitlab-token");
	if (!secretToken) return reply(404, "Not found");
	const body = await readBody(request);
	if (body === null) return reply(413, "The body is too large");
	let event: unknown;
	try {
		event = JSON.parse(body);
	} catch {
		return reply(400, "Not JSON");
	}
	const workspace = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.id, workspaceId))
		.get();
	if (!workspace) return reply(404, "Not found");
	const registry = await findRegistry(db, workspaceId);
	const outcome = await registry.gitlabDelivery(connectionId, secretToken, event);
	switch (outcome) {
		case "unknown":
		case "unauthorized":
			return reply(404, "Not found");
		case "ignored":
			return new Response(null, { status: 202 });
		case "queued":
			return new Response(null, { status: 204 });
	}
}

/** The body as text; null once it is larger than a push event, without reading the rest. */
async function readBody(request: Request): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
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
