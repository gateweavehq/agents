import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const ADA = "user-ada";
const GRACE = "user-grace";
const KEY = "sk-ant-api03-abcdefgh";

/** A workspace with a keyed agent, and a turn of Ada's that opened a run. */
async function turn(stub = registry(), member = ADA) {
	const agent = await stub.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const conversation = (await stub.startConversation(agent.id, member))?.id ?? "";
	const begun = await stub.beginTurn(conversation, "Hello");
	if ("status" in begun) throw new Error(begun.message);
	return { stub, agent, conversation, runId: begun.runId };
}

const finished = {
	status: "succeeded" as const,
	error: null,
	steps: 1,
	inputTokens: 1_200,
	outputTokens: 300,
	cachedInputTokens: 1_000,
	cost: 5_200,
	endedAt: Date.now() + 1_000,
};

describe("runs", () => {
	it("open when a turn calls the model, and close once with what it used", async () => {
		const { stub, agent, conversation, runId } = await turn();
		expect(await stub.getRun(runId)).toMatchObject({
			id: runId,
			agentId: agent.id,
			agentName: "Reviewer",
			conversationId: conversation,
			startedBy: ADA,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			status: "running",
			steps: 0,
			cost: null,
			endedAt: null,
		});

		expect(await stub.finishRun(runId, finished)).toBe(true);
		expect(await stub.getRun(runId)).toMatchObject(finished);
		// The first report wins: a late one from the same turn changes nothing.
		expect(await stub.finishRun(runId, { ...finished, status: "failed", error: "Late" })).toBe(
			false,
		);
		expect((await stub.getRun(runId))?.status).toBe("succeeded");
	});

	it("carry the pull request their turn opened, while they go", async () => {
		const { stub, runId } = await turn();
		expect((await stub.getRun(runId))?.pullRequest).toBeNull();
		const pullRequest = {
			repository: "acme/site",
			number: 12,
			url: "https://github.com/acme/site/pull/12",
		};
		expect(await stub.recordRunPullRequest(runId, pullRequest)).toBe(true);
		expect((await stub.getRun(runId))?.pullRequest).toEqual(pullRequest);

		await stub.finishRun(runId, finished);
		expect(
			await stub.recordRunPullRequest(runId, {
				...pullRequest,
				number: 13,
				url: "https://github.com/acme/site/pull/13",
			}),
		).toBe(false);
		expect((await stub.getRun(runId))?.pullRequest).toEqual(pullRequest);
	});

	it("are not opened for a turn that cannot call the model", async () => {
		const stub = registry();
		const agent = await stub.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
		});
		const conversation = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		expect(await stub.beginTurn(conversation, "Hello")).toHaveProperty("status", "refused");
		expect(await stub.listRuns()).toEqual([]);
	});

	it("list the latest first, everyone's or one member's, a page at a time", async () => {
		const { stub, runId: first } = await turn();
		const { runId: second } = await turn(stub, GRACE);
		const all = await stub.listRuns();
		expect(all.map((run) => run.id)).toEqual([second, first]);
		expect((await stub.listRuns({ startedBy: ADA })).map((run) => run.id)).toEqual([first]);
		const [latest, last] = all;
		if (!latest || !last) throw new Error("Expected two runs");
		expect((await stub.listRuns({ before: latest })).map((run) => run.id)).toEqual([first]);
		expect(await stub.listRuns({ before: last })).toEqual([]);
	});

	it("outlive their conversation, which keeps the workspace's usage counted", async () => {
		const { stub, conversation, runId } = await turn();
		await stub.finishRun(runId, finished);
		const { runId: priceless } = await turn(stub);
		await stub.finishRun(priceless, { ...finished, cost: null, inputTokens: 10, outputTokens: 5 });

		expect(await stub.removeConversation(conversation, ADA)).toEqual([conversation]);
		expect((await stub.getRun(runId))?.conversationId).toBeNull();
		expect(await stub.runUsage(0)).toEqual({
			runs: 2,
			inputTokens: 1_210,
			outputTokens: 305,
			cost: 5_200,
			unpriced: 1,
		});
		expect(await stub.runUsage(Date.now() + 60_000)).toEqual({
			runs: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			unpriced: 0,
		});
	});

	it("that never report back are closed as interrupted after an hour", async () => {
		const { stub, runId } = await turn();
		await runInDurableObject(stub, (_instance: RegistryDO, state) => {
			state.storage.sql.exec(
				"UPDATE runs SET started_at = ? WHERE id = ?",
				Date.now() - 61 * 60 * 1000,
				runId,
			);
		});
		expect(await stub.getRun(runId)).toMatchObject({ status: "interrupted", endedAt: null });

		// Its conversation, waking later, still knows what the run used, and says so once.
		const late = { ...finished, status: "interrupted" as const };
		expect(await stub.finishRun(runId, late)).toBe(true);
		expect(await stub.getRun(runId)).toMatchObject({
			status: "interrupted",
			endedAt: late.endedAt,
			inputTokens: late.inputTokens,
			cost: late.cost,
		});
		expect(await stub.finishRun(runId, finished)).toBe(false);
	});

	it("refuse a report that is not one", async () => {
		const { stub, runId } = await turn();
		await runInDurableObject(stub, (instance: RegistryDO) => {
			expect(() =>
				instance.finishRun(runId, { ...finished, status: "running" } as never),
			).toThrow();
			expect(() => instance.finishRun(runId, { ...finished, inputTokens: -1 })).toThrow();
		});
	});
});
