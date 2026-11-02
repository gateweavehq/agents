import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { FakeMcpServer } from "./fake-mcp";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

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

/** A conversation whose one run searched, then answered: two model requests. */
async function searchedOnce() {
	const acme = new FakeMcpServer([SEARCH], () => ({ content: [{ type: "text", text: FOUND }] }));
	const requests = fakeModel(
		(call) => {
			if (call === 0) return anthropicToolCall("acme__search", { query: "flaky" });
			if (call === 1) return anthropicStream("Three issues match.");
			return anthropicStream("Replayed.");
		},
		{ "mcp.acme.dev": acme.handle },
	);
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
		name: "Reviewer",
		description: null,
		provider: "anthropic" as const,
		model: "claude-sonnet-5-5",
		instructions: null,
		mcpServers: [{ assetId: server, version: 1, tools: null }],
	};
	const agent = await registry.createAgent(definition);
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
	it("answers from a step with the agent as it is now, and links back to the run", async () => {
		const { workspaceId, registry, stub, agent, definition, run, requests } = await searchedOnce();
		// The agent changed since: the replay uses the new model.
		await registry.updateAgent(agent.id, { ...definition, model: "claude-opus-5-5" });

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

	it("has nothing to replay for a run of another conversation", async () => {
		const { stub } = await searchedOnce();
		expect(await stub.replaySource(crypto.randomUUID(), 0)).toBeNull();
	});
});
