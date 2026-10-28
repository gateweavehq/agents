import { env } from "cloudflare:workers";
import type { EdgeSpan, Run } from "@gateweave/agents-model";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import {
	anthropicStream,
	anthropicToolCall,
	ask,
	connect,
	fakeModel,
	KEY,
	type ModelRequest,
} from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

const NAMES = ["Planner", "Coder", "Tester"] as const;
type Name = (typeof NAMES)[number];

/**
 * A conversation with Builders: Planner leads, delegates to Coder, and asks and reports to
 * Tester. Each agent's instructions say who it is, which is how the fake model tells them apart.
 */
async function builders() {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const ids: Record<string, string> = {};
	for (const name of NAMES) {
		const rules = await registry.createLibraryAsset({
			kind: "instructions",
			name: `${name.toLowerCase()}-rules`,
			text: `You are ${name}.\n`,
		});
		const agent = await registry.createAgent({
			name,
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: { assetId: rules, version: 1 },
		});
		ids[name] = agent.id;
	}
	const [planner = "", coder = "", tester = ""] = NAMES.map((name) => ids[name] ?? "");
	const team = (await registry.createTeam({ name: "Builders", description: null, lead: planner }))
		.id;
	const graph = {
		lead: planner,
		members: [planner, coder, tester].map((id) => ({ kind: "agent" as const, id })),
		edges: [
			{ from: planner, to: coder, kind: "delegate" as const },
			{ from: planner, to: tester, kind: "ask" as const },
			{ from: planner, to: tester, kind: "report" as const },
		],
	};
	await registry.setTeamGraph(team, graph);
	const conversation = (await registry.startTeamConversation(team, "user-ada"))?.id ?? "";
	const stub = await getAgentByName(env.CONVERSATIONS, conversationName(workspaceId, conversation));
	return { workspaceId, registry, stub, team, graph };
}

const whose = (request: ModelRequest): Name | undefined =>
	NAMES.find((name) => JSON.stringify(request.body.system).includes(`You are ${name}.`));

/** Answers each agent's requests in turn, with the answers given for it. */
function teamModel(
	answers: Partial<Record<Name, ((request: ModelRequest) => Response | Promise<Response>)[]>>,
) {
	const counts = new Map<Name, number>();
	return fakeModel((_call, request) => {
		const name = whose(request);
		if (!name) throw new Error("A request from nobody in the team");
		const at = counts.get(name) ?? 0;
		counts.set(name, at + 1);
		const answer = answers[name]?.[at];
		if (!answer) throw new Error(`${name} made a request the test did not expect`);
		return answer(request);
	});
}

const toolNames = (request: ModelRequest | undefined) =>
	((request?.body.tools as { name: string }[] | undefined) ?? []).map((tool) => tool.name);

/** The runs of the workspace, the person's first and the nested ones after it. */
async function runs(registry: ReturnType<typeof env.REGISTRY.getByName>) {
	const all = await registry.listRuns();
	const root = all.find((run) => run.parentRunId === null);
	return { root, nested: all.filter((run) => run.parentRunId !== null), all };
}

async function traceOf(workspaceId: string, run: Run | undefined) {
	const conversation = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, run?.conversationId ?? ""),
	);
	return conversation.runTrace(run?.id ?? "");
}

describe("a conversation with a team", () => {
	it("lets the lead delegate a task and answer with the result, each turn a run", async () => {
		const { workspaceId, registry, stub } = await builders();
		const requests = teamModel({
			Planner: [
				() => anthropicToolCall("delegate__Coder", { task: "Write the login form" }),
				() => anthropicStream("The form is ready."),
			],
			Coder: [() => anthropicStream("Form written.")],
		});
		const socket = await connect(stub);

		const turn = await ask(socket, "Build the login page");
		expect(turn).toMatchObject({ text: "The form is ready.", error: null });
		const [first, coder, second] = requests;
		expect(toolNames(first)).toEqual(["delegate__Coder", "ask__Tester", "report__Tester"]);
		// Coder sees the task, never the person's conversation, and has no edges of its own.
		expect(JSON.stringify(coder?.body.messages)).toContain("Write the login form");
		expect(JSON.stringify(coder?.body.messages)).not.toContain("Build the login page");
		expect(toolNames(coder)).toEqual([]);
		expect(JSON.stringify(second?.body.messages)).toContain("Form written.");
		socket.close();

		const { root, nested, all } = await runs(registry);
		expect(all).toHaveLength(2);
		const [child] = nested;
		expect(root).toMatchObject({ agentName: "Planner", status: "succeeded", steps: 2 });
		expect(child).toMatchObject({
			agentName: "Coder",
			status: "succeeded",
			parentRunId: root?.id,
			rootRunId: root?.id,
			edge: "delegate",
			depth: 1,
			startedBy: "user-ada",
			inputTokens: 10,
			outputTokens: 5,
		});
		// The caller's trace has the call, which the nested run points back to.
		const edge = (await traceOf(workspaceId, root)).find(
			(span): span is EdgeSpan => span.kind === "edge",
		);
		expect(edge).toMatchObject({
			step: 0,
			status: "ok",
			edge: "delegate",
			to: "Coder",
			childRunId: child?.id,
			error: null,
		});
		expect(child?.parentSpanId).toBe(edge?.id);
		expect(await traceOf(workspaceId, child)).toMatchObject([{ kind: "model", status: "ok" }]);
		// Each run counts once.
		expect((await registry.runUsage(0)).runs).toBe(2);
	});

	it("asks with one request and no tools", async () => {
		const { registry, stub } = await builders();
		const requests = teamModel({
			Planner: [
				() => anthropicToolCall("ask__Tester", { question: "Is the form tested?" }),
				() => anthropicStream("Tester says yes."),
			],
			Tester: [() => anthropicStream("Yes.")],
		});
		const socket = await connect(stub);

		expect((await ask(socket, "Check the tests")).text).toBe("Tester says yes.");
		const tester = requests.find((request) => whose(request) === "Tester");
		expect(tester?.body.tools).toBeUndefined();
		expect(JSON.stringify(requests.at(-1)?.body.messages)).toContain("Yes.");
		socket.close();
		expect((await runs(registry)).nested).toMatchObject([
			{ agentName: "Tester", edge: "ask", status: "succeeded", steps: 1 },
		]);
	});

	it("reports without waiting for the other turn to end", async () => {
		const { registry, stub } = await builders();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		teamModel({
			Planner: [
				() => anthropicToolCall("report__Tester", { message: "The form shipped." }),
				() => anthropicStream("Told Tester."),
			],
			// Tester answers only once the test lets it, after Planner is done.
			Tester: [() => held.then(() => anthropicStream("Noted."))],
		});
		const socket = await connect(stub);

		expect((await ask(socket, "Tell Tester")).text).toBe("Told Tester.");
		await vi.waitFor(async () => expect((await runs(registry)).root?.status).toBe("succeeded"));
		expect((await runs(registry)).nested).toMatchObject([
			{ agentName: "Tester", edge: "report", status: "running" },
		]);
		release();
		await vi.waitFor(async () =>
			expect((await runs(registry)).nested[0]?.status).toBe("succeeded"),
		);
		socket.close();
	});

	it("passes the registry's refusal to the lead's model, as the tool's error", async () => {
		const { workspaceId, registry, stub, team, graph } = await builders();
		const requests = teamModel({
			Planner: [
				// The edge goes while Planner's first request is under way. The stub is made here, in
				// the conversation's request, since a stub serves only the request that made it.
				async () => {
					await env.REGISTRY.getByName(workspaceId).setTeamGraph(team, {
						...graph,
						edges: graph.edges.slice(1),
					});
					return anthropicToolCall("delegate__Coder", { task: "Write the login form" });
				},
				() => anthropicStream("Coder is not on the team any more."),
			],
		});
		const socket = await connect(stub);

		expect((await ask(socket, "Build the login page")).text).toBe(
			"Coder is not on the team any more.",
		);
		expect(JSON.stringify(requests.at(-1)?.body.messages)).toContain(
			"That edge is no longer in the team",
		);
		socket.close();
		const { root, nested } = await runs(registry);
		expect(nested).toEqual([]);
		expect((await traceOf(workspaceId, root)).find((span) => span.kind === "edge")).toMatchObject({
			status: "error",
			childRunId: null,
			error: "That edge is no longer in the team",
		});
	});

	it("stops a nested turn when the turn waiting for it stops", async () => {
		const { registry, stub } = await builders();
		const requests = teamModel({
			Planner: [() => anthropicToolCall("delegate__Coder", { task: "Take your time" })],
			Coder: [() => anthropicStream("Thinking", { end: false })],
		});
		const socket = await connect(stub);

		const id = crypto.randomUUID();
		const turn = ask(socket, "Build it", id);
		await vi.waitFor(() =>
			expect(requests.some((request) => whose(request) === "Coder")).toBe(true),
		);
		socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id }));
		await vi.waitFor(() =>
			expect(requests.find((request) => whose(request) === "Coder")?.signal?.aborted).toBe(true),
		);
		await turn;
		await vi.waitFor(async () => expect((await runs(registry)).nested[0]?.status).toBe("stopped"));
		socket.close();
	});
});
