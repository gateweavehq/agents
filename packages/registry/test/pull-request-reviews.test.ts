/**
 * The review of a pull request an agent opened: which runs make a delivery, how the
 * registry admits it, and what keeps it from being lost. Each test names the criterion it holds
 * the registry to.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	MAX_WORKSPACE_SANDBOXES,
	REVIEW_LIMITS,
	REVIEW_MESSAGE_LIMIT,
	REVIEW_RETRY_MINUTES,
	type RepositoryInput,
	type RunFinish,
	type RunPullRequestInput,
	reviewDeliveryId,
	reviewMessage,
	reviewSummary,
	type TrackSourceSave,
} from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";
import { RUN_TIMEOUT } from "../src/runs";
import type { RegistryDO as TestRegistry } from "./worker";

type Stub = ReturnType<typeof registry>;
const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const ADA = "user-ada";
const KEY = "sk-ant-api03-abcdefgh";
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const PULL = {
	repository: "acme/site",
	number: 12,
	url: "https://github.com/acme/site/pull/12",
};
const FINISHED: RunFinish = {
	status: "succeeded",
	error: null,
	steps: 1,
	inputTokens: 10,
	outputTokens: 5,
	cachedInputTokens: 0,
	cost: null,
	endedAt: Date.now() + 1_000,
};

const github = (externalId: string, name: string): RepositoryInput => ({
	provider: "github",
	externalId,
	installationId: "100",
	owner: "acme",
	name,
	defaultBranch: "main",
	private: true,
});

/** A workspace with a builder, a review agent with a sandbox and its pull request trigger. */
async function workspace(perDay?: number) {
	const stub = registry();
	// Alarms fire on their own in the test pool; here each is run when a step asks for it.
	await (stub as unknown as { holdAlarms(): Promise<void> }).holdAlarms();
	await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = ""] = await stub.syncRepositories([github("7", "site")]);
	const agent = (name: string, sandbox: boolean) =>
		stub.createAgent({
			name,
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox,
		});
	const builder = await agent("Builder", false);
	const sandboxed = await agent("Sandboxed builder", true);
	const reviewer = await agent("Reviewer", true);
	const made = await stub.createReviewTrigger(
		{
			name: "Review pull requests",
			prompt: "Review it",
			target: { kind: "agent", agentId: reviewer.id },
			...(perDay === undefined ? {} : { perDay }),
		},
		ADA,
	);
	if ("status" in made) throw new Error(made.message);
	return { stub, repositoryId, builder, sandboxed, reviewer, trigger: made.trigger };
}

/** A run of `agent` that recorded `pull` and ended as `status`; returns the run's id. */
async function built(
	stub: Stub,
	agent: { id: string },
	pull: Partial<RunPullRequestInput> | null = {},
	status: RunFinish["status"] = "succeeded",
) {
	const conversation = (await stub.startConversation(agent.id, ADA))?.id ?? "";
	const begun = await stub.beginTurn(conversation, "Build it");
	if ("status" in begun) throw new Error(begun.message);
	if (pull) await stub.recordRunPullRequest(begun.runId, { ...PULL, head: HEAD, ...pull });
	await stub.finishRun(begun.runId, { ...FINISHED, status });
	return begun.runId;
}

/** Runs `fn` on a registry whose server binds sandboxes and the GitHub App, as the app's does. */
function withSandboxes<T>(
	stub: Stub,
	fn: (instance: TestRegistry) => Promise<T>,
	limits: Record<string, string> = {},
) {
	return runInDurableObject(stub, async (instance: RegistryDO) => {
		const { env: settings } = instance as unknown as { env: Record<string, unknown> };
		const added = {
			SANDBOX: {},
			GITHUB_APP_ID: "1",
			GITHUB_APP_PRIVATE_KEY: "unused",
			...limits,
		};
		Object.assign(settings, added);
		try {
			return await fn(instance as unknown as TestRegistry);
		} finally {
			for (const name of Object.keys(added)) delete settings[name];
		}
	});
}

/** Makes every queued review due now, as its wait passing would. */
const due = (stub: Stub) =>
	runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE pull_request_reviews SET next_attempt_at = 1");
	});

/** Has the alarm admit what is due, on a server with sandboxes. */
const alarm = (stub: Stub, limits?: Record<string, string>) =>
	withSandboxes(stub, (instance) => instance.alarmNow(), limits);

/** Fills every sandbox slot with a turn of the sandboxed builder that is still going. */
async function fillSlots(stub: Stub, agent: { id: string }) {
	const conversations: string[] = [];
	for (let n = 0; n < MAX_WORKSPACE_SANDBOXES; n++) {
		conversations.push((await stub.startConversation(agent.id, ADA))?.id ?? "");
	}
	await withSandboxes(stub, async (instance) => {
		for (const id of conversations) {
			expect(await instance.beginTurn(id, "Build it")).toMatchObject({ sandbox: true });
		}
	});
}

/** Ends every run that was going, as turns do, so their slots free after the idle minutes. */
const freeSlots = (stub: Stub) =>
	runInDurableObject(stub, (_instance, state) => {
		const ended = Date.now() - 60 * 60_000;
		state.storage.sql.exec(
			"UPDATE runs SET status = 'succeeded', ended_at = ? WHERE status = 'running'",
			ended,
		);
	});

describe("one delivery per final head (criterion 1)", () => {
	it("makes exactly one delivery for the head a run left, under the delivery's id", async () => {
		const { stub, repositoryId, builder, trigger } = await workspace();
		const conversation = (await stub.startConversation(builder.id, ADA))?.id ?? "";
		const begun = await stub.beginTurn(conversation, "Build it");
		if ("status" in begun) throw new Error(begun.message);
		// The run pushed twice: the record keeps the last head, which is the final one.
		await stub.recordRunPullRequest(begun.runId, { ...PULL, head: HEAD });
		await stub.recordRunPullRequest(begun.runId, { ...PULL, head: NEXT });
		// Nothing is made while the run goes.
		expect(await stub.listPullRequestReviews()).toEqual([]);
		await stub.finishRun(begun.runId, FINISHED);

		const reviews = await stub.listPullRequestReviews();
		expect(reviews).toHaveLength(1);
		expect(reviews[0]).toMatchObject({
			triggerId: trigger.id,
			id: reviewDeliveryId(repositoryId, 12, NEXT),
			repository: "acme/site",
			number: 12,
			head: NEXT,
			sourceRunId: begun.runId,
			status: "queued",
			runId: null,
		});
		// The same call again, as a retried report would be, makes nothing more.
		expect(await stub.finishRun(begun.runId, FINISHED)).toBe(false);
		expect(await stub.listPullRequestReviews()).toHaveLength(1);
	});

	it("makes none for a second run that ends at the same head", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		await built(stub, builder);
		expect(await stub.listPullRequestReviews()).toHaveLength(1);
		// A later head is a new delivery.
		await built(stub, builder, { head: NEXT });
		expect((await stub.listPullRequestReviews()).map((review) => review.head)).toEqual([
			HEAD,
			NEXT,
		]);
	});

	it("makes none for a run that ended failed or stopped, or that opened no pull request", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder, {}, "failed");
		await built(stub, builder, {}, "stopped");
		await built(stub, builder, null);
		// A run from before heads were recorded has nothing to review either.
		await built(stub, builder, { head: undefined });
		expect(await stub.listPullRequestReviews()).toEqual([]);
	});

	it("makes none for a repository the workspace does not reach", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder, {
			repository: "acme/elsewhere",
			url: "https://github.com/acme/elsewhere/pull/12",
		});
		expect(await stub.listPullRequestReviews()).toEqual([]);
	});

	it("makes none outside the repository a repository-bound reviewer is for", async () => {
		const { stub, builder, trigger, repositoryId } = await workspace();
		const [otherId = ""] = await stub.syncRepositories([github("8", "other")]);
		await stub.deleteTrigger(trigger.id);
		const reviewer = await stub.createAgent({
			name: "Other reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox: true,
			repositoryId: otherId,
		});
		const made = await stub.createReviewTrigger(
			{
				name: "Review other",
				prompt: "Review it",
				target: { kind: "agent", agentId: reviewer.id },
			},
			ADA,
		);
		if ("status" in made) throw new Error(made.message);

		await built(stub, builder);
		expect(await stub.listPullRequestReviews()).toEqual([]);
		await built(stub, builder, {
			repository: "acme/other",
			url: "https://github.com/acme/other/pull/12",
			head: NEXT,
		});
		expect(await stub.listPullRequestReviews()).toEqual([
			expect.objectContaining({ repository: "acme/other", triggerId: made.trigger.id }),
		]);

		// The scope is checked again as the queued review starts: the reviewer may have moved meanwhile.
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE agent_definitions SET repository_id = ? WHERE agent_id = ?",
				repositoryId,
				reviewer.id,
			);
		});
		await alarm(stub);
		expect(await stub.listPullRequestReviews()).toEqual([
			expect.objectContaining({
				status: "failed",
				reason: expect.stringContaining("another repository"),
			}),
		]);
	});
});

describe("pull requests that are not reviewed (criterion 5, as amended)", () => {
	it("makes none for a closed or merged pull request", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder, { state: "closed" });
		await built(stub, builder, { state: "merged", head: NEXT });
		expect(await stub.listPullRequestReviews()).toEqual([]);
	});

	it("makes none for a head that was already reviewed, whatever came of that review", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		await withSandboxes(stub, (instance) => instance.alarmNow());
		const [first] = await stub.listPullRequestReviews();
		expect(first).toMatchObject({ status: "running" });
		await built(stub, builder);
		expect(await stub.listPullRequestReviews()).toHaveLength(1);
		// Even once that review ended without a result.
		if (!first?.runId) throw new Error("The review did not begin");
		await stub.finishRun(first.runId, { ...FINISHED, status: "failed", error: "It broke" });
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({ status: "failed" });
		await built(stub, builder);
		expect(await stub.listPullRequestReviews()).toHaveLength(1);
	});

	it("reviews a draft, and the summary says it is one and why when the run recorded why", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder, {
			draft: true,
			draftReason: "Its checks failed: pnpm test exited 1.",
		});
		await built(stub, builder, { draft: true, head: NEXT });
		const [why, nowhy] = await stub.listPullRequestReviews();
		expect(why).toMatchObject({
			status: "queued",
			draft: true,
			draftReason: "Its checks failed: pnpm test exited 1.",
		});
		expect(nowhy).toMatchObject({ status: "queued", draft: true, draftReason: null });
		const counts = { found: 2, shown: 1, proven: 1 };
		expect(reviewSummary({ ...counts, draft: true, draftReason: why?.draftReason ?? null })).toBe(
			"This pull request is a draft. Why: Its checks failed: pnpm test exited 1.\n\n2 findings, 1 shown, 1 proven.",
		);
		expect(reviewSummary({ ...counts, draft: true, draftReason: null })).toContain(
			"a draft, and the run that opened it did not record why",
		);
		expect(reviewSummary({ ...counts, draft: false, draftReason: null })).toBe(
			"2 findings, 1 shown, 1 proven.",
		);
		// A pull request that is not a draft keeps no reason.
		await built(stub, builder, { head: "c".repeat(40), draftReason: "Stale" });
		expect((await stub.listPullRequestReviews())[2]).toMatchObject({
			draft: false,
			draftReason: null,
		});
	});
});

describe("the trigger's limits, pause and ownership apply", () => {
	it("admits a delivery as a trigger's, owned by it, and shows it in what came lately", async () => {
		const { stub, builder, trigger } = await workspace();
		await built(stub, builder);
		await withSandboxes(stub, (instance) => instance.alarmNow());
		const [review] = await stub.listPullRequestReviews();
		expect(review).toMatchObject({ status: "running" });
		const run = await stub.getRun(review?.runId ?? "");
		// The run belongs to the trigger, so owners and admins see it and members do not.
		expect(run).toMatchObject({
			startedBy: `trigger:${trigger.id}`,
			triggerId: trigger.id,
			sandbox: true,
			status: "running",
		});
		const [entry] = await stub.listTriggers();
		expect(entry?.pullRequest).toBe(true);
		expect(entry?.deliveries).toMatchObject([
			{ id: review?.id, status: "started", event: "pull_request", runId: review?.runId },
		]);
	});

	it("skips a delivery to a paused trigger, and shows why", async () => {
		const { stub, builder, trigger } = await workspace();
		await stub.updateTrigger(trigger.id, { active: false });
		await built(stub, builder);
		await withSandboxes(stub, (instance) => instance.alarmNow());
		expect(await stub.listPullRequestReviews()).toMatchObject([
			{ status: "skipped", reason: "The trigger was paused" },
		]);
		const [entry] = await stub.listTriggers();
		expect(entry?.deliveries).toMatchObject([
			{ status: "skipped", error: "The trigger was paused" },
		]);
	});

	it("holds the trigger to its runs for the day, and tries the delivery again", async () => {
		const { stub, builder } = await workspace(1);
		await built(stub, builder);
		await built(stub, builder, { head: NEXT });
		await withSandboxes(stub, (instance) => instance.alarmNow());
		const reviews = await stub.listPullRequestReviews();
		expect(reviews.map((review) => review.status)).toEqual(["running", "queued"]);
		expect(reviews[1]).toMatchObject({
			retries: 1,
			reason: "The trigger started its 1 run for the day",
		});
	});

	it("has no URL for webhooks to post to", async () => {
		const { stub, trigger } = await workspace();
		const id = crypto.randomUUID();
		expect(
			await stub.receiveTrigger(
				trigger.id,
				{ id, timestamp: String(Math.floor(Date.now() / 1000)), signature: "v1,AAAA" },
				"{}",
			),
		).toEqual({ status: "not_found" });
	});
});

describe("a review trigger's agent", () => {
	it("must be able to review: an agent without a sandbox is refused, and told what to turn on", async () => {
		const { stub, builder, sandboxed } = await workspace();
		const made = (agentId: string) =>
			stub.createReviewTrigger(
				{ name: "Another", prompt: "Review it", target: { kind: "agent", agentId } },
				ADA,
			);
		expect(await made(builder.id)).toMatchObject({
			status: "refused",
			message: expect.stringContaining("no sandbox"),
		});
		expect((await stub.listTriggers()).filter((entry) => entry.pullRequest)).toHaveLength(1);
		expect(await made(sandboxed.id)).toHaveProperty("trigger");
	});
});

describe("no delivery is lost (criterion 4)", () => {
	it("tries a delivery again when every sandbox is in use, and begins it once one is free", async () => {
		const { stub, builder, sandboxed } = await workspace();
		await fillSlots(stub, sandboxed);
		await built(stub, builder);
		await alarm(stub);
		const [refused] = await stub.listPullRequestReviews();
		expect(refused).toMatchObject({ status: "queued", retries: 1, runId: null });
		expect(refused?.reason).toContain("are using all");
		// It waits, and does not hold the alarm: the first wait is minutes, not a day.
		expect(refused?.nextAttemptAt).toBeGreaterThan(Date.now() + 4 * 60_000);
		expect(refused?.nextAttemptAt).toBeLessThan(Date.now() + 6 * 60_000);
		// No run began, so no sandbox is held for it.
		expect((await stub.listRuns()).filter((run) => run.triggerId !== null)).toEqual([]);

		await freeSlots(stub);
		await due(stub);
		await alarm(stub);
		const [begun] = await stub.listPullRequestReviews();
		expect(begun).toMatchObject({ status: "running", retries: 1 });
		expect(await stub.getRun(begun?.runId ?? "")).toMatchObject({ sandbox: true });
	});

	it("tries again when the day's sandbox minutes are used up", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		const used = { SANDBOX_DAILY_MINUTES: "0" };
		await alarm(stub, used);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "queued",
			retries: 1,
		});
		expect((await stub.listPullRequestReviews())[0]?.reason).toContain("minutes");
		await due(stub);
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({ status: "running" });
	});

	it("tries up to six times over a day, then ends the delivery as failed and says so", async () => {
		const { stub, builder, sandboxed } = await workspace();
		await fillSlots(stub, sandboxed);
		await built(stub, builder);
		expect(REVIEW_RETRY_MINUTES).toHaveLength(6);
		expect(REVIEW_RETRY_MINUTES.reduce((sum, minutes) => sum + minutes, 0)).toBeLessThanOrEqual(
			24 * 60,
		);
		for (let tried = 1; tried <= 6; tried++) {
			await due(stub);
			await alarm(stub);
			expect((await stub.listPullRequestReviews())[0]).toMatchObject({
				status: "queued",
				retries: tried,
			});
		}
		await due(stub);
		await alarm(stub);
		const [last] = await stub.listPullRequestReviews();
		expect(last).toMatchObject({ status: "failed", retries: 6, nextAttemptAt: null });
		expect(last?.reason).toContain("tried again 6 times over a day");
		// Nothing is tried after that.
		await due(stub);
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({ status: "failed" });
	});

	it("holds the sandbox slots while a review runs, and takes no more than the workspace has", async () => {
		const { stub, builder, sandboxed } = await workspace();
		await built(stub, builder);
		await built(stub, builder, { head: NEXT });
		await built(stub, builder, { head: "c".repeat(40) });
		await built(stub, builder, { head: "d".repeat(40) });
		// Fill all but one slot, so only one of the four reviews can begin at once.
		const conversations: string[] = [];
		for (let n = 0; n < MAX_WORKSPACE_SANDBOXES - 1; n++) {
			conversations.push((await stub.startConversation(sandboxed.id, ADA))?.id ?? "");
		}
		await withSandboxes(stub, async (instance) => {
			for (const id of conversations) await instance.beginTurn(id, "Build it");
			await instance.alarmNow();
		});
		const statuses = (await stub.listPullRequestReviews()).map((review) => review.status);
		expect(statuses.filter((status) => status === "running")).toHaveLength(1);
		// One alarm admits three: the one that began and two sent back. The fourth waits its turn.
		expect(statuses.filter((status) => status === "queued")).toHaveLength(3);
		const retried = (await stub.listPullRequestReviews()).filter((review) => review.retries === 1);
		expect(retried).toHaveLength(2);
		const running = (await stub.listRuns()).filter((run) => run.triggerId !== null);
		expect(running).toHaveLength(1);
		expect(running[0]).toMatchObject({ sandbox: true, status: "running" });
	});
});

describe("how a review ends", () => {
	/** A review whose run has begun: the review agent's conversation and its run. */
	async function begun() {
		const ready = await workspace();
		await built(ready.stub, ready.builder);
		await withSandboxes(ready.stub, (instance) => instance.alarmNow());
		const [review] = await ready.stub.listPullRequestReviews();
		if (!review?.runId) throw new Error("The review did not begin");
		return { ...ready, review, runId: review.runId };
	}

	it("keeps the counts the run recorded, and is posted when the run succeeds with them", async () => {
		const { stub, runId } = await begun();
		expect(await stub.recordReviewCounts(runId, { found: 3, shown: 2, proven: 1 })).toBe(true);
		await stub.finishRun(runId, FINISHED);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "posted",
			found: 3,
			shown: 2,
			proven: 1,
			reason: null,
		});
		// A report after the run ended changes nothing.
		expect(await stub.recordReviewCounts(runId, { found: 9, shown: 9, proven: 9 })).toBe(false);
	});

	it("fails when the run ends without findings, or does not succeed", async () => {
		const quiet = await begun();
		await quiet.stub.finishRun(quiet.runId, FINISHED);
		expect((await quiet.stub.listPullRequestReviews())[0]).toMatchObject({
			status: "failed",
			reason: "The review ended without submitting its findings",
		});
		const broken = await begun();
		await broken.stub.finishRun(broken.runId, {
			...FINISHED,
			status: "failed",
			error: "The model refused",
		});
		expect((await broken.stub.listPullRequestReviews())[0]).toMatchObject({
			status: "failed",
			reason: "The model refused",
		});
	});

	it("is skipped, with the reason, and its delivery with it, when the runtime says so", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		let conversationId = "";
		await withSandboxes(stub, async (instance) => {
			await instance.alarmNow();
			conversationId = instance.startedReviews()[0] ?? "";
			// The run began; the runtime found the head gone and ends it.
			expect(instance.skipReviewOf(conversationId, "The head is no longer on GitHub")).toBe(true);
		});
		expect(await stub.listPullRequestReviews()).toMatchObject([
			{ status: "skipped", reason: "The head is no longer on GitHub" },
		]);
		const [entry] = await stub.listTriggers();
		expect(entry?.deliveries).toMatchObject([
			{ status: "skipped", error: "The head is no longer on GitHub" },
		]);
		// A skipped review is settled: asking again changes nothing.
		expect(await stub.skipReviewOf(conversationId, "Again")).toBe(false);
	});
});

/** What the test worker adds to the registry: GitHub's word on pull requests, and the message. */
type Controls = {
	livePull(
		number: number,
		state: { state: "open" | "closed" | "merged"; head: string; draft: boolean } | "gone" | null,
	): Promise<void>;
	pullsRead(): Promise<number[]>;
	reviewMessageIs(text: string): Promise<void>;
};
const controls = (stub: Stub) => stub as unknown as Controls;
const open = (head = HEAD, draft = false) => ({ state: "open" as const, head, draft });

describe("one delivery for a head in the workspace, whatever the number of triggers", () => {
	it("makes one delivery with two review triggers, for the oldest that is on", async () => {
		const { stub, builder, reviewer, trigger } = await workspace();
		const second = await stub.createReviewTrigger(
			{
				name: "Second review",
				prompt: "Review it again",
				target: { kind: "agent", agentId: reviewer.id },
			},
			ADA,
		);
		if ("status" in second) throw new Error(second.message);
		const ordered = [trigger, second.trigger].sort(
			(a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
		);
		await built(stub, builder);
		await built(stub, builder);
		let reviews = await stub.listPullRequestReviews();
		expect(reviews).toHaveLength(1);
		expect(reviews[0]?.triggerId).toBe(ordered[0]?.id);

		// One alarm admits it once: one delivery, on the one trigger, whichever is asked.
		await withSandboxes(stub, (instance) => instance.alarmNow());
		const entries = await stub.listTriggers();
		expect(entries.flatMap((entry) => entry.deliveries)).toHaveLength(1);
		expect(entries.find((entry) => entry.id === ordered[0]?.id)?.deliveries).toHaveLength(1);

		// When the oldest is paused, the next head goes to the one that is on, and a paused one is
		// chosen only when none is on.
		await stub.updateTrigger(ordered[0]?.id ?? "", { active: false });
		await built(stub, builder, { head: NEXT });
		reviews = await stub.listPullRequestReviews();
		expect(reviews).toHaveLength(2);
		expect(reviews[1]?.triggerId).toBe(ordered[1]?.id);
		await stub.updateTrigger(ordered[1]?.id ?? "", { active: false });
		await built(stub, builder, { head: "c".repeat(40) });
		expect((await stub.listPullRequestReviews())[2]?.triggerId).toBe(ordered[0]?.id);
	});

	it("chooses the trigger whose reviewer is bound to the pull request's repository", async () => {
		const { stub, builder, trigger, repositoryId } = await workspace();
		const [otherId = ""] = await stub.syncRepositories([github("8", "other")]);
		await stub.deleteTrigger(trigger.id);
		const bound = (name: string, repository: string) =>
			stub.createAgent({
				name,
				description: null,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: null,
				sandbox: true,
				repositoryId: repository,
			});
		const other = await bound("Other reviewer", otherId);
		const site = await bound("Site reviewer", repositoryId);
		const make = async (agentId: string, name: string) => {
			const made = await stub.createReviewTrigger(
				{ name, prompt: "Review it", target: { kind: "agent", agentId } },
				ADA,
			);
			if ("status" in made) throw new Error(made.message);
			return made.trigger;
		};
		// The wrong repository's trigger is older: compatibility, not age alone, chooses.
		const otherTrigger = await make(other.id, "Review other");
		const siteTrigger = await make(site.id, "Review site");

		await built(stub, builder);
		await built(stub, builder, {
			repository: "acme/other",
			url: "https://github.com/acme/other/pull/12",
			head: NEXT,
		});
		expect(await stub.listPullRequestReviews()).toEqual([
			expect.objectContaining({ repository: "acme/site", triggerId: siteTrigger.id }),
			expect.objectContaining({ repository: "acme/other", triggerId: otherTrigger.id }),
		]);
	});

	it("does not review a head again when the trigger that reviewed it is replaced", async () => {
		const { stub, builder, reviewer, trigger } = await workspace();
		await built(stub, builder);
		await withSandboxes(stub, (instance) => instance.alarmNow());
		const [running] = await stub.listPullRequestReviews();
		if (!running?.runId) throw new Error("The review did not begin");
		await stub.recordReviewCounts(running.runId, { found: 1, shown: 1, proven: 0 });
		await stub.finishRun(running.runId, FINISHED);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({ status: "posted" });

		// The trigger is deleted and another made in its place.
		expect(await stub.deleteTrigger(trigger.id)).toBe(true);
		const replacement = await stub.createReviewTrigger(
			{
				name: "Replacement",
				prompt: "Review it",
				target: { kind: "agent", agentId: reviewer.id },
			},
			ADA,
		);
		if ("status" in replacement) throw new Error(replacement.message);
		// A second run that ends at the reviewed head makes no delivery for the new trigger.
		await built(stub, builder);
		const reviews = await stub.listPullRequestReviews();
		expect(reviews).toHaveLength(1);
		expect(reviews[0]).toMatchObject({ status: "posted", triggerId: null, found: 1 });
		await withSandboxes(stub, (instance) => instance.alarmNow());
		expect((await stub.listTriggers())[0]?.deliveries).toEqual([]);
		// A head after it is the new trigger's.
		await built(stub, builder, { head: NEXT });
		expect((await stub.listPullRequestReviews())[1]).toMatchObject({
			triggerId: replacement.trigger.id,
			status: "queued",
		});
	});

	it("moves a queued review to the trigger that remains, and drops it with the last one", async () => {
		const { stub, builder, reviewer, trigger } = await workspace();
		const second = await stub.createReviewTrigger(
			{ name: "Second", prompt: "Review it", target: { kind: "agent", agentId: reviewer.id } },
			ADA,
		);
		if ("status" in second) throw new Error(second.message);
		await built(stub, builder);
		const chosen = (await stub.listPullRequestReviews())[0]?.triggerId ?? "";
		const other = chosen === trigger.id ? second.trigger.id : trigger.id;
		await stub.deleteTrigger(chosen);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "queued",
			triggerId: other,
		});
		await withSandboxes(stub, (instance) => instance.alarmNow());
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({ status: "running" });
		await stub.deleteTrigger(other);
		// Its run goes on without a trigger; the row stays so the head is not reviewed again.
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "running",
			triggerId: null,
		});

		const lone = await workspace();
		await built(lone.stub, lone.builder);
		await lone.stub.deleteTrigger(lone.trigger.id);
		expect(await lone.stub.listPullRequestReviews()).toEqual([]);
	});
});

describe("a pull request closed before its review is admitted (criterion 5)", () => {
	it("is held to GitHub's state before any delivery is made, whatever the builder recorded", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		await controls(stub).livePull(12, { state: "closed", head: HEAD, draft: false });
		await alarm(stub);
		expect(await stub.listPullRequestReviews()).toMatchObject([
			{ status: "skipped", reason: "The pull request is closed", runId: null },
		]);
		// No delivery, conversation or run exists for it.
		expect((await stub.listTriggers())[0]?.deliveries).toEqual([]);
		const runs = await stub.listRuns();
		expect(runs.filter((run) => run.triggerId !== null)).toEqual([]);
		expect(await controls(stub).pullsRead()).toEqual([12]);
	});

	it("skips a merged pull request, one whose head moved on and one GitHub no longer has", async () => {
		const { stub, builder } = await workspace();
		const at = (number: number) => ({
			number,
			url: `https://github.com/acme/site/pull/${number}`,
		});
		await built(stub, builder);
		await built(stub, builder, { head: NEXT, ...at(13) });
		await built(stub, builder, { head: "c".repeat(40), ...at(14) });
		await controls(stub).livePull(12, { state: "merged", head: HEAD, draft: false });
		await controls(stub).livePull(13, open("d".repeat(40)));
		await controls(stub).livePull(14, "gone");
		await alarm(stub);
		const ended = (await stub.listPullRequestReviews()).map(({ status, reason }) => [
			status,
			reason,
		]);
		expect(ended).toEqual([
			["skipped", "The pull request is closed"],
			["skipped", "The reviewed head is no longer the pull request's head on GitHub"],
			["skipped", "The pull request was not found on GitHub"],
		]);
		expect((await stub.listTriggers())[0]?.deliveries).toEqual([]);
	});

	it("admits an open one at its head, with GitHub's word on whether it is a draft", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder, { draft: true, draftReason: "Its checks failed." });
		await controls(stub).livePull(12, open(HEAD, false));
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "running",
			draft: false,
			draftReason: null,
		});
		expect((await stub.listTriggers())[0]?.deliveries).toHaveLength(1);
	});

	it("makes no delivery while GitHub cannot be read, and none for a pull request found closed after", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		// The preflight read fails: the review stays queued, with no delivery, conversation or run.
		await controls(stub).livePull(12, null);
		await alarm(stub);
		const [waiting] = await stub.listPullRequestReviews();
		expect(waiting).toMatchObject({ status: "queued", retries: 1, runId: null });
		expect(waiting?.reason).toContain("could not confirm");
		expect((await stub.listTriggers())[0]?.deliveries).toEqual([]);
		expect((await stub.listRuns()).filter((run) => run.triggerId !== null)).toEqual([]);

		// The next read answers that the pull request is closed: it is skipped, and still no delivery.
		await controls(stub).livePull(12, { state: "closed", head: HEAD, draft: false });
		await due(stub);
		await alarm(stub);
		expect(await stub.listPullRequestReviews()).toMatchObject([
			{ status: "skipped", reason: "The pull request is closed", runId: null },
		]);
		expect((await stub.listTriggers())[0]?.deliveries).toEqual([]);
		expect(await controls(stub).pullsRead()).toEqual([12, 12]);
	});

	it("admits it once GitHub answers that the pull request is open at its head", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		await controls(stub).livePull(12, null);
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({ status: "queued" });
		await controls(stub).livePull(12, open());
		await due(stub);
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "running",
			retries: 1,
		});
		expect((await stub.listTriggers())[0]?.deliveries).toHaveLength(1);
	});

	it("fails the review, with no delivery, when GitHub is never read in its six tries", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		await controls(stub).livePull(12, null);
		for (let tried = 1; tried <= 6; tried++) {
			await due(stub);
			await alarm(stub);
			expect((await stub.listPullRequestReviews())[0]).toMatchObject({
				status: "queued",
				retries: tried,
			});
		}
		await due(stub);
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "failed",
			retries: 6,
		});
		expect((await stub.listTriggers())[0]?.deliveries).toEqual([]);
	});
});

/**
 * A valid unified diff of exactly `bytes` bytes: one new file whose hunk header counts the lines it
 * holds. `git apply --numstat` reads it, as it does any diff GitHub makes.
 */
function diffOfBytes(bytes: number): string {
	const size = (text: string) => new TextEncoder().encode(text).length;
	const row = `+${"é".repeat(39)}
`;
	const head = (lines: number) =>
		`diff --git a/big.txt b/big.txt
new file mode 100644
--- /dev/null
+++ b/big.txt
@@ -0,0 +1,${lines} @@
`;
	let lines = 0;
	for (let again = 0; again < 3; again++) {
		lines = Math.floor((bytes - size(head(lines))) / size(row));
	}
	const slack = bytes - size(head(lines)) - lines * size(row);
	// The last line takes up what is left, so the diff is as long as the limit allows.
	const last = `+${"é".repeat(39)}${"x".repeat(slack)}
`;
	return `${head(lines)}${row.repeat(lines - 1)}${last}`;
}

describe("a review whose run never reports (criterion 4)", () => {
	it("is given up on by an alarm of its own, in a workspace with nothing else to do", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		await alarm(stub);
		const [review] = await stub.listPullRequestReviews();
		expect(review).toMatchObject({ status: "running" });
		// Nothing is queued and nothing else is due, yet the alarm is set, for when the run is given up on.
		const set = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
		expect(set).not.toBeNull();
		expect(set ?? 0).toBeGreaterThan(Date.now() + RUN_TIMEOUT);
		expect(set ?? 0).toBeLessThan(Date.now() + RUN_TIMEOUT + 11 * 60_000);

		// When it comes, and the run never said anything, the review is failed.
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE pull_request_reviews SET updated_at = 1");
		});
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({
			status: "failed",
			reason: "The review's run did not report back",
		});
	});
});

describe("Track reporting", () => {
	it("copies the source run's destination and reports the review under its own run id", async () => {
		const { stub, builder } = await workspace();
		const destinationId = crypto.randomUUID();
		const source = {
			trackOrigin: "https://track.example.com",
			sourceKey: `gws_${"s".repeat(43)}`,
			source: { id: "source", name: "Gateweave Agents", product: "agents" },
			workspace: { id: "workspace", slug: "acme", name: "Acme" },
			team: { id: "team", key: "OPS", name: "Operations" },
		} satisfies TrackSourceSave;
		expect(await stub.saveTrackSource(destinationId, source)).toBe("saved");

		const conversation = (await stub.startConversation(builder.id, ADA))?.id ?? "";
		const begun = await stub.beginTurn(conversation, "Build it");
		if ("status" in begun) throw new Error(begun.message);
		await stub.recordRunPullRequest(begun.runId, { ...PULL, head: HEAD });
		const target = {
			destinationId,
			sourceId: source.source.id,
			origin: source.trackOrigin,
			workspaceId: source.workspace.id,
			teamId: source.team.id,
			issue: "OPS-42",
			issueId: "issue",
			agent: "Coder",
			runsPage: "https://agents.example.com/acme/runs/",
		};
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE runs SET track_report = ? WHERE id = ?",
				JSON.stringify({ target, runningAt: Date.now() }),
				begun.runId,
			);
		});
		await stub.finishRun(begun.runId, FINISHED);
		await alarm(stub);
		const [review] = await stub.listPullRequestReviews();
		expect(review).toMatchObject({ status: "running" });
		if (!review?.runId) throw new Error("The review did not begin");
		expect(review.runId).not.toBe(begun.runId);

		const reports = async () =>
			runInDurableObject(stub, (_instance, state) => {
				const rows = state.storage.sql.exec("SELECT report FROM track_report_outbox").toArray() as {
					report: unknown;
				}[];
				return rows.map(
					({ report }) =>
						(typeof report === "string" ? JSON.parse(report) : report) as {
							key: string;
							target: { destinationId: string; issue: string; issueId: string };
							phase: { state: string };
						},
				);
			});
		const running = (await reports()).find(
			(report) => report.key === review.runId && report.phase.state === "running",
		);
		expect(running?.target).toMatchObject({
			destinationId,
			issue: "OPS-42",
			issueId: "issue",
		});

		await stub.recordReviewCounts(review.runId, { found: 1, shown: 1, proven: 1 });
		await stub.finishRun(review.runId, FINISHED);
		const succeeded = (await reports()).find(
			(report) => report.key === review.runId && report.phase.state === "passed",
		);
		expect(succeeded?.target).toMatchObject({
			destinationId,
			issue: "OPS-42",
			issueId: "issue",
		});
	});
});

describe("the review's message (criterion 4)", () => {
	it("begins with a valid diff's message at the published limit, over 100,000 characters", async () => {
		const { stub, builder } = await workspace();
		await built(stub, builder);
		const diff = diffOfBytes(REVIEW_LIMITS.diffBytes);
		expect(new TextEncoder().encode(diff).length).toBe(REVIEW_LIMITS.diffBytes);
		const text = reviewMessage(diff, ["T".repeat(256), "b".repeat(65_536)]);
		expect(text.length).toBeGreaterThan(100_000);
		expect(text.length).toBeLessThanOrEqual(REVIEW_MESSAGE_LIMIT);
		await controls(stub).reviewMessageIs(text);
		await alarm(stub);
		expect((await stub.listPullRequestReviews())[0]).toMatchObject({ status: "running" });
	});

	it("is the longest the review's envelope can make: fences, a title and a description", () => {
		// The worst patch for the fence: backticks and tildes in runs as long as the diff allows.
		const run = REVIEW_LIMITS.diffBytes / 2 - 1;
		const patch = `${"`".repeat(run)}${"~".repeat(run)}\n`;
		const worst = reviewMessage(patch, ["T".repeat(256), "🙂".repeat(65_536)]);
		expect(worst.length).toBeLessThanOrEqual(REVIEW_MESSAGE_LIMIT);
		const wide = reviewMessage("é".repeat(REVIEW_LIMITS.diffBytes), [
			"T".repeat(256),
			"b".repeat(65_536),
		]);
		expect(wide.length).toBeLessThanOrEqual(REVIEW_MESSAGE_LIMIT);
	});
});
