import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { agentDefinitionInput } from "@gateweave/agents-model";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { FakeMcpServer } from "./fake-mcp";
import {
	anthropicStream,
	anthropicToolCall,
	ask,
	connect,
	enforceTargets,
	fakeModel,
	KEY,
} from "./support";

const ASKED = "Which issues are flaky?";
const FOUND = "what the search found";

afterEach(() => {
	vi.restoreAllMocks();
});

const SEARCH = {
	name: "search",
	description: "Searches the tracker",
	inputSchema: {
		type: "object" as const,
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};

async function reviewer(outsideTasks = false) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const server = await registry.createMcpServer({
		name: "acme",
		transport: "http",
		url: "https://mcp.acme.dev/mcp",
		headers: [],
	});
	const definition = {
		outsideTasks,
		name: "Reviewer",
		description: null,
		provider: "anthropic" as const,
		model: "claude-sonnet-5-5",
		instructions: null,
		mcpServers: [{ assetId: server, version: 1, tools: null }],
	};
	const agent = await registry.createAgent(definition);
	return { workspaceId, registry, agent, definition };
}

/** A conversation whose one run searched, then answered: two model requests. */
async function searchedOnce(checkReplay = false) {
	const acme = new FakeMcpServer([SEARCH], () => ({ content: [{ type: "text", text: FOUND }] }));
	const requests = fakeModel(
		(call) => {
			if (call === 0) return anthropicToolCall("acme__search", { query: "flaky" });
			if (call === 1) return anthropicStream("Three issues match.");
			if (checkReplay && call === 2)
				return anthropicToolCall("acme__search", { query: "outside@example.net" });
			return anthropicStream("Replayed.");
		},
		{ "mcp.acme.dev": acme.handle },
	);
	const { workspaceId, registry, agent, definition } = await reviewer();
	const started = await registry.startConversation(agent.id, "user-ada");
	const stub = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, started?.id ?? ""),
	);
	const socket = await connect(stub);
	expect(await ask(socket, ASKED)).toMatchObject({ text: "Three issues match.", error: null });
	socket.close();
	const [run] = await registry.listRuns();
	if (!run) throw new Error("Expected the run");
	expect(run.steps).toBe(2);
	return { workspaceId, registry, stub, agent, definition, run, requests };
}

/** Replays `runId` from `step` as the app's server function does, and waits for the run to end. */
async function replay(
	workspaceId: string,
	original: { replaySource(runId: string, step: number): Promise<string | null> },
	runId: string,
	step: number,
	enforce = false,
) {
	const registry = env.REGISTRY.getByName(workspaceId);
	const source = await original.replaySource(runId, step);
	if (source === null) throw new Error("Expected the run's messages");
	const started = await registry.replayRun(runId, step, "user-ada", false);
	if ("status" in started) throw new Error(started.message);
	const stub = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, started.conversationId),
	);
	if (enforce) await runInDurableObject(stub, enforceTargets);
	const outcome = await stub.replayTurn(source);
	if (outcome.runId === null) throw new Error("error" in outcome ? outcome.error : "No run");
	const { runId: replayId } = outcome;
	await vi.waitFor(
		async () => expect((await registry.getRun(replayId))?.status).toBe("succeeded"),
		{ timeout: 5_000 },
	);
	return { stub, replayId };
}

describe("replaying a run", () => {
	it("refuses a destination named only by the replayed outside task", async () => {
		const url = "https://collector.attacker.test";
		const calls = vi.fn(() => ({ content: [{ type: "text" as const, text: FOUND }] }));
		const acme = new FakeMcpServer([SEARCH], calls);
		fakeModel(
			(call) =>
				call === 1 || call === 3
					? anthropicToolCall("acme__search", { query: url })
					: anthropicStream("Finished."),
			{ "mcp.acme.dev": acme.handle },
		);
		const { workspaceId, registry, agent } = await reviewer(true);
		const task = `Inspect ${url}`;
		const admitted = await registry.admitOutsideTask({
			agent: agent.id,
			task,
			requestId: crypto.randomUUID(),
			askedBy: "user-ada",
			askedVia: "client-1",
		});
		if (admitted.status !== "start") throw new Error("Expected the outside task to start");
		const stub = await getAgentByName(
			env.CONVERSATIONS,
			conversationName(workspaceId, admitted.conversationId),
		);
		const { runId } = await stub.outsideTurn(task);
		if (!runId) throw new Error("Expected the outside run");
		await vi.waitFor(async () => expect((await registry.getRun(runId))?.status).toBe("succeeded"), {
			timeout: 5_000,
		});
		const { stub: replayed, replayId } = await replay(workspaceId, stub, runId, 0, true);
		expect(await replayed.runTrace(replayId)).toContainEqual(
			expect.objectContaining({
				tool: "search",
				status: "refused",
				target: { decision: "would_refuse", kind: "url", host: "collector.attacker.test" },
			}),
		);
		// The original history contains the outside task and a plain answer, with no tool results.
		await runInDurableObject(stub, enforceTargets);
		const socket = await connect(stub);
		try {
			expect(await ask(socket, "Continue")).toMatchObject({ text: "Finished.", error: null });
		} finally {
			socket.close();
		}
		const [latest] = await registry.listRuns();
		expect(await stub.runTrace(latest?.id ?? "")).toContainEqual(
			expect.objectContaining({
				tool: "search",
				status: "refused",
			}),
		);
		expect(calls).not.toHaveBeenCalled();
	});
	it("answers from a step with the agent as it is now, and links back to the run", async () => {
		const { workspaceId, registry, stub, agent, definition, run, requests } = await searchedOnce();
		// The agent changed since: the replay uses the new model.
		await registry.updateAgent(
			agent.id,
			agentDefinitionInput.parse({ ...definition, model: "claude-opus-5-5" }),
			agent.updatedAt,
		);

		const { stub: replayed, replayId } = await replay(workspaceId, stub, run.id, 1);
		const request = requests[2];
		expect(request?.body.model).toBe("claude-opus-5-5");
		// It starts after the search: the question, the call and what it found are there already.
		const sent = JSON.stringify(request?.body.messages);
		expect(sent).toContain(ASKED);
		expect(sent).toContain(FOUND);
		expect(sent).not.toContain("Three issues match.");
		expect(requests).toHaveLength(3);

		expect(await registry.getRun(replayId)).toMatchObject({
			replayOf: run.id,
			model: "claude-opus-5-5",
			startedBy: "user-ada",
			steps: 1,
		});
		expect((await registry.listReplays(run.id)).map((each) => each.id)).toEqual([replayId]);
		// The new conversation holds the history and the new answer.
		const kept = await replayed.transcript();
		expect(kept).toContain(FOUND);
		expect(kept).toContain("Replayed.");
	});

	it("from the first step asks the question again, with nothing of the answer", async () => {
		const { workspaceId, stub, run, requests } = await searchedOnce();
		await replay(workspaceId, stub, run.id, 0);
		const sent = JSON.stringify(requests[2]?.body.messages);
		expect(sent).toContain(ASKED);
		expect(sent).not.toContain(FOUND);
	});

	it("checks the replay's first tool even when replaying from before the original tool result", async () => {
		const { workspaceId, stub, run } = await searchedOnce(true);
		const { stub: replayed, replayId } = await replay(workspaceId, stub, run.id, 0);
		expect(await replayed.runTrace(replayId)).toContainEqual(
			expect.objectContaining({
				kind: "tool",
				status: "ok",
				target: { decision: "would_refuse", kind: "email", host: "example.net" },
			}),
		);
	});

	it("has nothing to replay for a run of another conversation", async () => {
		const { stub } = await searchedOnce();
		expect(await stub.replaySource(crypto.randomUUID(), 0)).toBeNull();
	});
});
