import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type RegistryStub, startAgents } from "./agents-worker";
import { ask } from "./chat-socket";
import { FakeModels } from "./fake-models";

const origin = "https://agents.test";
const KEY = "sk-ant-api03-correct-horse-battery";

const models = new FakeModels({ [KEY]: { provider: "anthropic", models: ["claude-sonnet-5-5"] } });

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { models });
});

afterAll(async () => {
	await agents?.dispose();
});

/** A workspace with an agent, Reviewer, and a key for its provider. */
async function workspace(slug: string) {
	const owner = await signUp(agents, origin, `ada-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	return { owner, workspaceId, registry, agentId: agent.id };
}

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments.
	return (await response.text()).replaceAll("<!-- -->", "");
}

/** The run once the runtime has reported how it ended, which can come just after the reply. */
async function settled(registry: RegistryStub, runId: string) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const run = await registry.getRun(runId);
		if (run && run.status !== "running") return run;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("The run did not end");
}

it("records each answer as a run, with its trace and estimated cost", async () => {
	const { owner, registry, agentId } = await workspace("runs-forge");
	const conversation = await registry.startConversation(agentId, owner.userId);
	if (!conversation) throw new Error("The conversation did not start");
	const cookie = owner.headers.cookie;
	const { socket } = await agents.connect(`${origin}/api/chat/runs-forge/${conversation.id}`, {
		cookie,
		origin,
	});
	if (!socket) throw new Error("No WebSocket");
	await ask(socket, "Review my change, please");
	socket.close();

	const [listed] = await registry.listRuns();
	if (!listed) throw new Error("No run was recorded");
	// The fake model reads 10 tokens and writes 5: $2 and $10 a million on Sonnet 5.5.
	expect(await settled(registry, listed.id)).toMatchObject({
		status: "succeeded",
		conversationId: conversation.id,
		startedBy: owner.userId,
		steps: 1,
		inputTokens: 10,
		outputTokens: 5,
		cost: 70,
	});

	const list = await page("/runs-forge/runs", cookie);
	expect(list).toContain("Reviewer");
	expect(list).toContain("Succeeded");
	expect(list).toContain("$0.00007");

	const run = await page(`/runs-forge/runs/${listed.id}`, cookie);
	expect(run).toContain("Model request 1");
	expect(run).toContain("Answered");
	expect(run).toContain("Open the conversation");
	// A trace is timing and usage: the conversation's words and the key stay out of it.
	expect(run).not.toContain("Review my change");
	expect(run).not.toContain("correct-horse");

	const overview = await page("/runs-forge", cookie);
	expect(overview).toContain("Last 30 days");
	expect(overview).toContain("$0.00007");

	// Deleting the conversation takes its trace along, and the run stays counted.
	expect(await registry.removeConversation(conversation.id, owner.userId)).toBe(true);
	const after = await page(`/runs-forge/runs/${listed.id}`, cookie);
	expect(after).toContain("was deleted, and its trace with it");
	expect(after).not.toContain("Open the conversation");
	expect((await registry.runUsage(0)).cost).toBe(70);
});

it("shows members their own runs, admins everyone's, and outsiders nothing", async () => {
	const { owner, workspaceId, registry, agentId } = await workspace("runs-guild");
	const grace = await signUp(agents, origin, "grace-runs");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace.userId, Date.now())
		.run();

	/** A turn in a new conversation, which failed before it reached the model. */
	async function failedRun(startedBy: string) {
		const conversation = await registry.startConversation(agentId, startedBy);
		const turn = await registry.beginTurn(conversation?.id ?? "", "Hello");
		if ("status" in turn) throw new Error(turn.message);
		await registry.finishRun(turn.runId, {
			status: "failed",
			error: "Reviewer could not finish its answer.",
			steps: 0,
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			cost: 0,
			endedAt: Date.now(),
		});
		return turn.runId;
	}
	const adas = await failedRun(owner.userId);
	const graces = await failedRun(grace.userId);

	// A member sees the runs they started, and nobody else's.
	const theirs = await page("/runs-guild/runs", grace.headers.cookie);
	expect(theirs).toContain(graces);
	expect(theirs).not.toContain(adas);
	expect(await page(`/runs-guild/runs/${adas}`, grace.headers.cookie)).toContain("Run not found");

	// The owner sees everyone's, with who started each, but not a way into others' conversations.
	const all = await page("/runs-guild/runs", owner.headers.cookie);
	expect(all).toContain(adas);
	expect(all).toContain(graces);
	expect(all).toContain("grace-runs");
	const hers = await page(`/runs-guild/runs/${graces}`, owner.headers.cookie);
	expect(hers).toContain("Reviewer could not finish its answer.");
	expect(hers).toContain("The run ended before it called the model.");
	expect(hers).not.toContain("Open the conversation");

	// Anyone else gets the answer a missing workspace gets.
	const eve = await signUp(agents, origin, "eve-runs");
	const outsider = await agents.fetch(`${origin}/runs-guild/runs`, {
		headers: { cookie: eve.headers.cookie },
	});
	expect(outsider.status).toBe(404);
	const body = await outsider.text();
	expect(body).not.toContain(adas);
	expect(body).not.toContain("Reviewer");
	const detail = await agents.fetch(`${origin}/runs-guild/runs/${graces}`, {
		headers: { cookie: eve.headers.cookie },
	});
	expect(detail.status).toBe(404);
});
