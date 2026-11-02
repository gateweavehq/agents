import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { type OtlpSpan, type OtlpTraces, runSpanIdOf, spanIdOf } from "../src/otlp";
import { sendDue } from "../src/telemetry-export";
import type { Sql } from "../src/trace";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const API_KEY = "otel-api-key-which-stays-secret";
const ASKED = "Build the login page, which no span may say";

afterEach(() => {
	vi.restoreAllMocks();
});

/** An OTLP receiver, which answers with the statuses given, in turn, then 200. */
function receiver(statuses: number[] = []) {
	const received: { headers: Headers; body: OtlpTraces }[] = [];
	const handle = async (request: Request) => {
		received.push({ headers: request.headers, body: (await request.json()) as OtlpTraces });
		return new Response(null, { status: statuses.shift() ?? 200 });
	};
	return { received, handle };
}

const spansOf = (traces: OtlpTraces | undefined) =>
	traces?.resourceSpans.flatMap((resource) =>
		resource.scopeSpans.flatMap((scope) => scope.spans),
	) ?? [];

const attribute = (span: OtlpSpan | undefined, key: string) =>
	span?.attributes.find((entry) => entry.key === key)?.value;

/** A workspace that exports traces, with Planner, who delegates to Coder in a team. */
async function team() {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	await registry.setTelemetry(
		{ endpoint: "https://otel.acme.dev", headers: [{ name: "x-api-key", value: API_KEY }] },
		"Ada",
	);
	const agent = async (name: string) => {
		const rules = await registry.createLibraryAsset({
			kind: "instructions",
			name: `${name.toLowerCase()}-rules`,
			text: `You are ${name}.\n`,
		});
		return (
			await registry.createAgent({
				name,
				description: null,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: { assetId: rules, version: 1 },
			})
		).id;
	};
	const planner = await agent("Planner");
	const coder = await agent("Coder");
	const team = (await registry.createTeam({ name: "Builders", description: null, lead: planner }))
		.id;
	await registry.setTeamGraph(team, {
		lead: planner,
		members: [planner, coder].map((id) => ({ kind: "agent" as const, id })),
		edges: [{ from: planner, to: coder, kind: "delegate" as const }],
	});
	const conversation = (await registry.startTeamConversation(team, "user-ada"))?.id ?? "";
	const stub = await getAgentByName(env.CONVERSATIONS, conversationName(workspaceId, conversation));
	return { workspaceId, registry, stub };
}

/** A workspace that exports traces, with one agent to talk to. */
async function single() {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	await registry.setTelemetry({ endpoint: "https://otel.acme.dev", headers: [] }, "Ada");
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	const conversation = (await registry.startConversation(agent.id, "user-ada"))?.id ?? "";
	const stub = await getAgentByName(env.CONVERSATIONS, conversationName(workspaceId, conversation));
	return { workspaceId, registry, stub };
}

function plannerAndCoder(otel: (request: Request) => Promise<Response>) {
	let planner = 0;
	return fakeModel(
		(_call, request) => {
			if (JSON.stringify(request.body.system).includes("You are Coder.")) {
				return anthropicStream("Form written.");
			}
			planner += 1;
			return planner === 1
				? anthropicToolCall("delegate__Coder", { task: "Write the login form" })
				: anthropicStream("The form is ready.");
		},
		{ "otel.acme.dev": otel },
	);
}

describe("OpenTelemetry export", () => {
	it("sends each run as spans, a team's nested run in its caller's trace, with no words", async () => {
		const otel = receiver();
		plannerAndCoder(otel.handle);
		const { workspaceId, registry, stub } = await team();
		const socket = await connect(stub);
		expect(await ask(socket, ASKED)).toMatchObject({ text: "The form is ready.", error: null });
		socket.close();

		await vi.waitFor(() => expect(otel.received).toHaveLength(2), { timeout: 5_000 });
		const [root] = await registry.listRuns();
		const [child] = root ? await registry.listNestedRuns(root.id) : [];
		if (!root || !child) throw new Error("Expected Planner's run and Coder's");

		for (const { headers, body } of otel.received) {
			expect(headers.get("x-api-key")).toBe(API_KEY);
			expect(headers.get("content-type")).toBe("application/json");
			expect(body.resourceSpans[0]?.resource.attributes).toContainEqual({
				key: "gateweave.workspace.id",
				value: { stringValue: workspaceId },
			});
			expect(JSON.stringify(body)).not.toContain(ASKED);
			expect(JSON.stringify(body)).not.toContain("Write the login form");
		}
		const all = otel.received.flatMap(({ body }) => spansOf(body));
		const traceId = root.id.replace(/-/g, "");
		expect(new Set(all.map((span) => span.traceId))).toEqual(new Set([traceId]));

		// Planner's run: the agent's span, its two model requests under it, the edge under the first.
		const plannerSpan = all.find((span) => span.spanId === runSpanIdOf(root.id));
		expect(plannerSpan).toMatchObject({
			name: "invoke_agent Planner",
			status: { code: 1 },
		});
		expect(plannerSpan?.parentSpanId).toBeUndefined();
		expect(attribute(plannerSpan, "gen_ai.operation.name")).toEqual({
			stringValue: "invoke_agent",
		});
		expect(attribute(plannerSpan, "gen_ai.usage.input_tokens")).toEqual({
			intValue: String(root.inputTokens),
		});
		const chats = all.filter(
			(span) => span.name === "chat claude-sonnet-5-5" && span.parentSpanId === plannerSpan?.spanId,
		);
		expect(chats).toHaveLength(2);
		const edge = all.find((span) => span.name.startsWith("delegate "));
		expect(edge?.parentSpanId).toBe(chats[0]?.spanId);
		expect(attribute(edge, "gateweave.child_run.id")).toEqual({ stringValue: child.id });

		// Coder's run hangs under the edge that started it.
		const coderSpan = all.find((span) => span.spanId === runSpanIdOf(child.id));
		expect(coderSpan).toMatchObject({ name: "invoke_agent Coder", parentSpanId: edge?.spanId });
		expect(child.parentSpanId && spanIdOf(child.parentSpanId)).toBe(edge?.spanId);
		expect(all.filter((span) => span.parentSpanId === coderSpan?.spanId)).toMatchObject([
			{ name: "chat claude-sonnet-5-5" },
		]);

		expect((await registry.getTelemetry())?.lastExport).toMatchObject({ ok: true, error: null });
	});

	it("tries a failed send again later, and gives up on one the endpoint refuses", async () => {
		const otel = receiver([503]);
		fakeModel(() => anthropicStream("Hello."), { "otel.acme.dev": otel.handle });
		const { workspaceId, registry, stub } = await single();
		const socket = await connect(stub);
		await ask(socket, ASKED);
		socket.close();
		await vi.waitFor(() => expect(otel.received).toHaveLength(1), { timeout: 5_000 });
		await vi.waitFor(async () =>
			expect((await registry.getTelemetry())?.lastExport).toMatchObject({
				ok: false,
				error: "The endpoint answered with an error (HTTP 503)",
			}),
		);

		// The run waits in the outbox: a pass now sends nothing, and once it is due, it goes.
		await stub.exportTraces();
		expect(otel.received).toHaveLength(1);
		const later = Date.now() + 60 * 60_000;
		await runInDurableObject(stub, async (instance) => {
			const sql = (instance as unknown as { sql: Sql }).sql.bind(instance) as Sql;
			expect(
				await sendDue(sql, env.REGISTRY.getByName(workspaceId), workspaceId, () => later),
			).toBeNull();
		});
		expect(otel.received).toHaveLength(2);
		expect((await registry.getTelemetry())?.lastExport).toMatchObject({ ok: true });

		// An endpoint that refuses the key is not tried again.
		const refusing = receiver([401]);
		fakeModel(() => anthropicStream("Hello."), { "otel.acme.dev": refusing.handle });
		const again = await connect(stub);
		await ask(again, "Once more");
		again.close();
		await vi.waitFor(() => expect(refusing.received.length).toBeGreaterThan(0), { timeout: 5_000 });
		await vi.waitFor(async () =>
			expect((await registry.getTelemetry())?.lastExport).toMatchObject({
				ok: false,
				error: "The endpoint refused the headers (HTTP 401). Check its API key",
			}),
		);
		const sent = refusing.received.length;
		await runInDurableObject(stub, async (instance) => {
			const sql = (instance as unknown as { sql: Sql }).sql.bind(instance) as Sql;
			expect(
				await sendDue(sql, env.REGISTRY.getByName(workspaceId), workspaceId, () => later),
			).toBeNull();
		});
		expect(refusing.received).toHaveLength(sent);
	});

	it("sends nothing for a workspace that does not export", async () => {
		const otel = receiver();
		plannerAndCoder(otel.handle);
		const { registry, stub } = await team();
		await registry.removeTelemetry();
		const socket = await connect(stub);
		await ask(socket, ASKED);
		socket.close();
		await stub.exportTraces();
		expect(otel.received).toEqual([]);
	});
});
