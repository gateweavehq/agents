import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { USAGE_BLOBS, USAGE_DOUBLES, usagePoint, writeUsage } from "../src";

const workspaceName = () => crypto.randomUUID();

/** A workspace with a keyed agent, and a turn that opened a run. */
async function turn(workspace = workspaceName()) {
	const stub = env.REGISTRY.getByName(workspace);
	const agent = await stub.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
	const conversation = (await stub.startConversation(agent.id, "user-ada"))?.id ?? "";
	const begun = await stub.beginTurn(conversation, "Hello");
	if ("status" in begun) throw new Error(begun.message);
	return { stub, agent, runId: begun.runId };
}

/** A point's fields by name, as the queries in docs/self-hosting.md read them. */
function named(point: AnalyticsEngineDataPoint | undefined) {
	return {
		indexes: point?.indexes,
		blobs: Object.fromEntries(USAGE_BLOBS.map((field, i) => [field, point?.blobs?.[i]])),
		doubles: Object.fromEntries(USAGE_DOUBLES.map((field, i) => [field, point?.doubles?.[i]])),
	};
}

describe("usage events", () => {
	it("are written once for each run that closes, indexed by workspace", async () => {
		const workspace = workspaceName();
		const { stub, agent, runId } = await turn(workspace);
		expect(await stub.usageWritten()).toEqual([]);

		const run = await stub.getRun(runId);
		const endedAt = (run?.startedAt ?? 0) + 2_500;
		await stub.finishRun(runId, {
			status: "succeeded",
			error: null,
			steps: 2,
			inputTokens: 1_200,
			outputTokens: 300,
			cachedInputTokens: 1_000,
			cost: 5_200,
			endedAt,
		});
		// A late report closes nothing, and writes nothing.
		await stub.finishRun(runId, {
			status: "failed",
			error: "Late",
			steps: 9,
			inputTokens: 9,
			outputTokens: 9,
			cachedInputTokens: 0,
			cost: 9,
			endedAt,
		});

		const written = await stub.usageWritten();
		expect(written).toHaveLength(1);
		expect(named(written[0])).toEqual({
			indexes: [workspace],
			blobs: {
				run: runId,
				agent: agent.id,
				agentName: "Reviewer",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				status: "succeeded",
				trigger: "",
				rootRun: "",
			},
			doubles: {
				inputTokens: 1_200,
				outputTokens: 300,
				cachedInputTokens: 1_000,
				cost: 0.0052,
				priced: 1,
				steps: 2,
				seconds: 2.5,
				sandboxSeconds: 0,
				sandboxCost: 0,
			},
		});
	});

	it("say when a run has no price, rather than counting it as free", async () => {
		const { stub, runId } = await turn();
		await stub.finishRun(runId, {
			status: "failed",
			error: "Overloaded",
			steps: 1,
			inputTokens: 10,
			outputTokens: 0,
			cachedInputTokens: 0,
			cost: null,
			endedAt: Date.now(),
		});
		const [point] = await stub.usageWritten();
		expect(named(point).doubles).toMatchObject({ cost: 0, priced: 0 });
		expect(named(point).blobs).toMatchObject({ status: "failed" });
	});

	it("price a run's sandbox time as the Runs page does", async () => {
		const { stub, runId } = await turn();
		const run = await stub.getRun(runId);
		if (!run) throw new Error("Expected the run");
		const point = usagePoint("ws-1", { ...run, sandboxSeconds: 1_000 });
		expect(named(point).doubles.sandboxSeconds).toBe(1_000);
		expect(named(point).doubles.sandboxCost).toBeGreaterThan(0);
	});

	it("go nowhere without a dataset, and never stop a run from closing", () => {
		const point = { indexes: ["ws-1"], blobs: [], doubles: [] };
		expect(writeUsage(undefined, point)).toBe(false);
		expect(writeUsage({}, point)).toBe(false);
		const dataset = { writeDataPoint: vi.fn() };
		expect(writeUsage(dataset, point)).toBe(true);
		expect(dataset.writeDataPoint).toHaveBeenCalledWith(point);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const broken = {
			writeDataPoint: () => {
				throw new Error("Too many points");
			},
		};
		expect(writeUsage(broken, point)).toBe(false);
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	it("keep a field's place, so queries written for older points still read newer ones", () => {
		expect(USAGE_BLOBS.slice(0, 8)).toEqual([
			"run",
			"agent",
			"agentName",
			"provider",
			"model",
			"status",
			"trigger",
			"rootRun",
		]);
		expect(USAGE_DOUBLES.slice(0, 9)).toEqual([
			"inputTokens",
			"outputTokens",
			"cachedInputTokens",
			"cost",
			"priced",
			"steps",
			"seconds",
			"sandboxSeconds",
			"sandboxCost",
		]);
		// Analytics Engine takes at most 20 of each.
		expect(USAGE_BLOBS.length).toBeLessThanOrEqual(20);
		expect(USAGE_DOUBLES.length).toBeLessThanOrEqual(20);
	});
});
