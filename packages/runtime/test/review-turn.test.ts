/**
 * The review turn: what it starts with, what it can use, and which head it reads. The
 * registry admits a review as the alarm does, and the conversation runs it for real, against the
 * fake sandbox, with GitHub and the model as spies on `fetch`.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	CHECKS_HEADING,
	REVIEW_INSTRUCTIONS,
	REVIEW_LIMITS,
	REVIEW_MESSAGE_LIMIT,
	REVIEW_SKIPPED,
	reviewMessage,
} from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { pullRequestBody } from "../src/checks";
import { reviewCriteria } from "../src/review-turn";
import { type FakeSandbox, goneHeads, REVIEW_DIFF, sandboxDiff } from "./fake-sandbox";
import { anthropicStream, anthropicToolCall, fakeModel, KEY } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
	sandboxDiff.text = REVIEW_DIFF;
});

const HEAD = "a".repeat(40);
const MOVED = "c".repeat(40);
const SITE = {
	provider: "github" as const,
	externalId: "7",
	installationId: "99",
	owner: "acme",
	name: "site",
	defaultBranch: "main",
	private: true,
};
const TITLE = "Fix the cart";
const BODY = "Makes a quantity of zero count.";
const MERGE_BASE = "e".repeat(40);

/** GitHub as a review reads it: the pull request as JSON, and its diff for the diff media type. */
function github({
	state = "open",
	head = HEAD,
	diff = REVIEW_DIFF,
	body = BODY,
	base = "main",
	draft = false,
	mergeBases = [MERGE_BASE],
}: {
	state?: string;
	head?: string;
	/** The diff's text, or its raw bytes for a diff that is not UTF-8. */
	diff?: string | Uint8Array;
	body?: string;
	/** The branch the pull request is to be merged into. */
	base?: string;
	draft?: boolean;
	/**
	 * Where the head left the base, as GitHub answers each time it is asked: the base branch may
	 * advance between two readings, so a later answer can differ from an earlier one.
	 */
	mergeBases?: string[];
} = {}) {
	const asked: string[] = [];
	const reviews: {
		commit_id: string;
		body: string;
		event: string;
		comments: { path: string; line: number; side: string; body: string }[];
	}[] = [];
	let comparisons = 0;
	const handler = async (request: Request) => {
		const url = new URL(request.url);
		asked.push(`${request.method} ${url.pathname}`);
		if (url.pathname.endsWith("/access_tokens")) {
			const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
			return Response.json({ token: "ghs_review", expires_at: expiresAt }, { status: 201 });
		}
		if (request.headers.get("authorization") !== "Bearer ghs_review") {
			return Response.json({ message: "Bad credentials" }, { status: 401 });
		}
		const compare = /^\/repos\/acme\/site\/compare\/(.+)\.\.\.(.+)$/.exec(url.pathname);
		if (compare) {
			// A diff is made of two commits, which stay what they are whatever the branch does.
			if (request.headers.get("accept")?.includes("diff")) {
				return /^[0-9a-f]{40}$/.test(compare[1] ?? "")
					? new Response(diff)
					: Response.json({ message: "Not Found" }, { status: 404 });
			}
			const sha = mergeBases[Math.min(comparisons++, mergeBases.length - 1)];
			return Response.json({ merge_base_commit: { sha }, files: [] });
		}
		if (url.pathname === "/repos/acme/site/pulls/12/reviews" && request.method === "POST") {
			reviews.push((await request.json()) as (typeof reviews)[number]);
			return Response.json({ id: reviews.length }, { status: 201 });
		}
		if (url.pathname === "/repos/acme/site/pulls/12") {
			return Response.json({
				number: 12,
				html_url: "https://github.com/acme/site/pull/12",
				title: TITLE,
				body,
				state,
				merged_at: null,
				draft,
				head: { sha: head, ref: "gateweave/builder" },
				base: { ref: base },
			});
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	};
	return { asked, reviews, handler };
}

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

/** A workspace whose builder left a pull request at `HEAD`, and a review agent to read it. */
async function reviewing(recorded: { draft?: boolean; draftReason?: string } = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = ""] = await registry.syncRepositories([SITE]);
	const agent = (name: string, sandbox: boolean, memory = false) =>
		registry.createAgent({
			name,
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox,
			memory,
			// The builder has the repository, as an agent that opens pull requests does.
			repositoryId: sandbox ? repositoryId : null,
		});
	const builder = await agent("Builder", false);
	const reviewer = await agent("Reviewer", true);
	const made = await registry.createReviewTrigger(
		{
			name: "Review",
			prompt: "Review it",
			target: { kind: "agent", agentId: reviewer.id },
		},
		"user-ada",
	);
	if ("status" in made) throw new Error(made.message);
	// The builder's own conversation holds words the review must never see.
	const built = (await registry.startConversation(builder.id, "user-ada"))?.id ?? "";
	const begun = await registry.beginTurn(built, "Build it, BUILDER-SECRET-WORDS");
	if ("status" in begun) throw new Error(begun.message);
	await registry.recordRunPullRequest(begun.runId, {
		repository: "acme/site",
		number: 12,
		url: "https://github.com/acme/site/pull/12",
		head: HEAD,
		state: "open",
		...recorded,
	});
	await registry.finishRun(begun.runId, {
		status: "succeeded",
		error: null,
		steps: 1,
		inputTokens: 1,
		outputTokens: 1,
		cachedInputTokens: 0,
		cost: null,
		endedAt: Date.now() + 1_000,
	});
	return { registry, workspaceId, runId: begun.runId };
}

/** Has the registry's alarm admit the review, and waits until the review is not queued. */
async function admitted(registry: ReturnType<typeof env.REGISTRY.getByName>) {
	await runDurableObjectAlarm(registry);
	await vi.waitFor(async () => {
		const [review] = await registry.listPullRequestReviews();
		expect(review?.status).not.toBe("queued");
	});
	return (await registry.listPullRequestReviews())[0];
}

describe("a review turn", () => {
	it("starts from the diff and the criteria alone, with the sandbox's tools and submit_review", async () => {
		const { registry } = await reviewing();
		const pulls = github();
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": pulls.handler },
		);

		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({
				status: "posted",
				found: 0,
				shown: 0,
				proven: 0,
			}),
		);

		const request = requests[0];
		// The tools: the sandbox's, and the review's, and nothing else.
		const names = ((request?.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
		expect(names.sort()).toEqual([
			"edit_file",
			"find_files",
			"read_file",
			"run_command",
			"search",
			"submit_review",
			"write_file",
		]);
		for (const forbidden of ["open_pull_request", "remember", "recall", "forget"]) {
			expect(names).not.toContain(forbidden);
		}
		expect(names.some((name) => name.includes("__"))).toBe(false);
		// The message: exactly the review message, and nothing from the builder's conversation.
		const messages = request?.body.messages as { role: string; content: { text?: string }[] }[];
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "user" });
		expect(messages[0]?.content).toMatchObject([
			{ type: "text", text: reviewMessage(REVIEW_DIFF, [TITLE, BODY]) },
		]);
		expect(JSON.stringify(request?.body)).not.toContain("BUILDER-SECRET-WORDS");
		expect(JSON.stringify(request?.body.system)).toContain(REVIEW_INSTRUCTIONS.split("\n")[0]);
		expect(JSON.stringify(request?.body.system)).not.toContain("open_pull_request");

		// The run is the review's: it holds a sandbox slot, and the trigger owns it.
		const [review] = await registry.listPullRequestReviews();
		expect(await registry.getRun(review?.runId ?? "")).toMatchObject({
			status: "succeeded",
			sandbox: true,
		});
		expect(pulls.reviews).toHaveLength(1);
		expect(pulls.reviews[0]).toMatchObject({
			commit_id: HEAD,
			event: "COMMENT",
			comments: [],
		});
		expect(pulls.reviews[0]?.body).toContain(
			"A second reader's findings, not an approval. A person reviews and merges.",
		);
		expect(pulls.reviews[0]?.body).toContain("No findings. This is not an approval.");
		expect(pulls.reviews[0]?.body).toContain(
			`Review run: https://agents.example.test/runs/${review?.runId}`,
		);
		expect(pulls.reviews[0]?.body).toContain("<!-- AI-Disclosure: mode=machine-generated -->");
	});

	it("reviews the exact head: the sandbox checks out the pull request's head by commit id, detached", async () => {
		const { registry, workspaceId } = await reviewing();
		const pulls = github();
		fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": pulls.handler },
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		const [review] = await registry.listPullRequestReviews();
		const run = await registry.getRun(review?.runId ?? "");
		const machine = (env.SANDBOX as unknown as DurableObjectNamespace<FakeSandbox>).getByName(
			conversationName(workspaceId, run?.conversationId ?? ""),
		);
		const { checkouts } = await machine.seen();
		expect(checkouts).toMatchObject([
			{ repository: { owner: "acme", name: "site" }, review: { number: 12, head: HEAD } },
		]);
		// The pull request was read at the same commit it was queued for.
		expect(pulls.asked).toContain("GET /repos/acme/site/pulls/12");
	});

	it("ends as skipped when the head is no longer on GitHub, with that reason", async () => {
		// GitHub already names another head: the review of the old one has nothing to read.
		const moved = await reviewing();
		fakeModel(() => anthropicStream("Never asked."), {
			"api.github.com": github({ head: MOVED }).handler,
		});
		expect(await admitted(moved.registry)).toMatchObject({
			status: "skipped",
			reason: REVIEW_SKIPPED.headGone,
			runId: null,
		});
		// No run began, so no sandbox was used.
		expect((await moved.registry.listRuns()).filter((run) => run.triggerId !== null)).toEqual([]);
	});

	it("ends as skipped when the sandbox finds the head gone as it checks it out", async () => {
		const { registry } = await reviewing();
		fakeModel(() => anthropicStream("Never asked."), { "api.github.com": github().handler });
		// GitHub still names the head when the pull request is read, and has dropped it by the time
		// the sandbox fetches it.
		goneHeads.add(HEAD);
		try {
			await admitted(registry);
			await vi.waitFor(async () =>
				expect((await registry.listPullRequestReviews())[0]).toMatchObject({
					status: "skipped",
					reason: REVIEW_SKIPPED.headGone,
				}),
			);
		} finally {
			goneHeads.delete(HEAD);
		}
		// The run that began for it ended, and failed: nothing was reviewed.
		const [review] = await registry.listPullRequestReviews();
		await vi.waitFor(async () =>
			expect(await registry.getRun(review?.runId ?? "")).toMatchObject({ status: "failed" }),
		);
	});

	it("ends as skipped, with `too large to review`, and starts no run, when the diff is over the limit", async () => {
		const { registry } = await reviewing();
		const diff = `diff --git a/big b/big\n${"+x\n".repeat(REVIEW_LIMITS.diffBytes)}`;
		const requests = fakeModel(() => anthropicStream("Never asked."), {
			"api.github.com": github({ diff }).handler,
		});
		expect(await admitted(registry)).toMatchObject({
			status: "skipped",
			reason: REVIEW_SKIPPED.tooLarge,
			runId: null,
		});
		expect(REVIEW_SKIPPED.tooLarge).toContain("too large to review");
		expect(requests).toHaveLength(0);
		expect((await registry.listRuns()).filter((run) => run.triggerId !== null)).toEqual([]);
	});

	it("ends as skipped, with `too large to review`, when a diff under the limit in bytes decodes to more", async () => {
		const { registry } = await reviewing();
		// Latin-1 bytes: each `é` (0xE9) is not UTF-8 and decodes to a three-byte replacement
		// character, so 81,000 bytes from GitHub become 239,000 bytes of text, over the limit.
		const header = new TextEncoder().encode(
			"diff --git a/latin.txt b/latin.txt\n--- a/latin.txt\n+++ b/latin.txt\n@@ -0,0 +1,1000 @@\n",
		);
		const line = [0x2b, ...new Array<number>(79).fill(0xe9), 0x0a];
		const diff = new Uint8Array([...header, ...Array.from({ length: 1000 }, () => line).flat()]);
		expect(diff.length).toBeLessThan(REVIEW_LIMITS.diffBytes);
		const requests = fakeModel(() => anthropicStream("Never asked."), {
			"api.github.com": github({ diff }).handler,
		});
		expect(await admitted(registry)).toMatchObject({
			status: "skipped",
			reason: REVIEW_SKIPPED.tooLarge,
			runId: null,
		});
		expect(requests).toHaveLength(0);
	});

	it("makes no delivery when the pull request was closed after the builder recorded it open", async () => {
		const { registry } = await reviewing();
		const requests = fakeModel(() => anthropicStream("Never asked."), {
			"api.github.com": github({ state: "closed" }).handler,
		});
		expect(await admitted(registry)).toMatchObject({
			status: "skipped",
			reason: REVIEW_SKIPPED.closed,
			runId: null,
		});
		// The live state was read before the delivery was made: none exists, and no run began.
		const [entry] = await registry.listTriggers();
		expect(entry?.deliveries).toEqual([]);
		expect((await registry.listRuns()).filter((run) => run.triggerId !== null)).toEqual([]);
		expect(requests).toHaveLength(0);
	});

	it("makes no delivery for a head whose pull request moved on", async () => {
		const { registry } = await reviewing();
		fakeModel(() => anthropicStream("Never asked."), {
			"api.github.com": github({ head: MOVED }).handler,
		});
		expect(await admitted(registry)).toMatchObject({
			status: "skipped",
			reason: REVIEW_SKIPPED.headGone,
		});
		expect((await registry.listTriggers())[0]?.deliveries).toEqual([]);
	});

	it("reviews a draft, and the completed review says it is one and why the run recorded", async () => {
		const reason = "The repository's checks did not pass: check 1 of 1 exited with code 1.";
		const { registry } = await reviewing({ draft: true, draftReason: reason });
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": github({ draft: true }).handler },
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		expect((await registry.listPullRequestReviews())[0]).toMatchObject({
			draft: true,
			draftReason: reason,
		});
		// The summary is part of the review's result, the one the model and the conversation hold.
		const result = JSON.stringify(requests[1]?.body.messages);
		expect(result).toContain(`This pull request is a draft. Why: ${reason}`);
		expect(result).toContain("0 findings, 0 shown, 0 proven.");
	});

	it("says a draft did not record why, when GitHub says it is a draft and the run recorded none", async () => {
		// The builder meant the pull request to be ready; GitHub has it as a draft.
		const { registry } = await reviewing({ draft: false });
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": github({ draft: true }).handler },
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		expect((await registry.listPullRequestReviews())[0]).toMatchObject({
			draft: true,
			draftReason: null,
		});
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(
			"This pull request is a draft, and the run that opened it did not record why.",
		);
	});

	it("does not call a pull request a draft that GitHub has ready, whatever the run recorded", async () => {
		const { registry } = await reviewing({ draft: true, draftReason: "Its checks failed." });
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": github({ draft: false }).handler },
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		expect((await registry.listPullRequestReviews())[0]).toMatchObject({
			draft: false,
			draftReason: null,
		});
		const result = JSON.stringify(requests[1]?.body.messages);
		expect(result).not.toContain("is a draft");
		expect(result).toContain("0 findings, 0 shown, 0 proven.");
	});

	it("keeps the whole description: a criterion past 20,000 characters is in the message", async () => {
		const { registry } = await reviewing();
		const body = `${"Context. ".repeat(2_504)}\n\nFinal requirement: a quantity of zero is refused.`;
		expect(body.length).toBeGreaterThan(20_035);
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": github({ body }).handler },
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		const messages = requests[0]?.body.messages as { content: { text?: string }[] }[];
		const text = messages[0]?.content[0]?.text ?? "";
		expect(text).toBe(reviewMessage(REVIEW_DIFF, [TITLE, body.trim()]));
		expect(text).toContain("Final requirement: a quantity of zero is refused.");
	});

	it("begins a review of a valid diff at the published limit, with the longest description", async () => {
		const { registry } = await reviewing();
		// A valid diff of exactly the published limit: its hunk counts every line it holds.
		const diff = diffOfBytes(REVIEW_LIMITS.diffBytes);
		const bytes = new TextEncoder().encode(diff).length;
		expect(bytes).toBe(REVIEW_LIMITS.diffBytes);
		const added = diff.split("\n").filter((row) => row.startsWith("+") && !row.startsWith("+++"));
		expect(diff).toContain(`@@ -0,0 +1,${added.length} @@\n`);
		const body = "x".repeat(60_000);
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": github({ diff, body }).handler },
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		const messages = requests[0]?.body.messages as { content: { text?: string }[] }[];
		const text = messages[0]?.content[0]?.text ?? "";
		// Longer than the 100,000 characters the registry once refused, and within the shared limit.
		expect(text.length).toBeGreaterThan(100_000);
		expect(text.length).toBeLessThanOrEqual(REVIEW_MESSAGE_LIMIT);
		expect(text).toBe(reviewMessage(diff, [TITLE, body]));
	});

	it("reads the diff between two commits once and checks the findings against that same text", async () => {
		const { registry, workspaceId } = await reviewing();
		const later = "f".repeat(40);
		// The base branch advances between GitHub's readings: the second answer would name another commit.
		const pulls = github({ base: "release/1.x", mergeBases: [MERGE_BASE, later] });
		fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", { findings: [] })
					: anthropicStream("Nothing to report."),
			{ "api.github.com": pulls.handler },
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		// The branch was asked once, for the commit where the head left it; the diff is of commits.
		const compared = pulls.asked.filter((request) => request.includes("/compare/"));
		expect(compared).toEqual([
			`GET /repos/acme/site/compare/release%2F1.x...${HEAD}`,
			`GET /repos/acme/site/compare/${MERGE_BASE}...${HEAD}`,
		]);
		const [review] = await registry.listPullRequestReviews();
		const run = await registry.getRun(review?.runId ?? "");
		const machine = (env.SANDBOX as unknown as DurableObjectNamespace<FakeSandbox>).getByName(
			conversationName(workspaceId, run?.conversationId ?? ""),
		);
		const git = await machine.gitCalls();
		// The findings are checked against the diff the model read: the sandbox makes no other, and
		// reads no branch that may move.
		expect(git.some((args) => args[0] === "merge-base" || args.includes("diff"))).toBe(false);
		expect(git.flat().some((arg) => arg.startsWith("origin/"))).toBe(false);
		expect(git.flat()).not.toContain(later);
	});

	it("counts a finding on a line of the diff the model was given as inline, whatever the sandbox would make of it", async () => {
		const { registry } = await reviewing();
		const later = "f".repeat(40);
		// The base branch advanced: a diff made again would hold other hunks. The sandbox's own diff
		// here lacks app.ts line 1, which the model read, and holds other.ts line 7, which it did not.
		sandboxDiff.text = `diff --git a/other.ts b/other.ts
--- a/other.ts
+++ b/other.ts
@@ -7 +7 @@
-old
+new
`;
		const finding = {
			severity: "high",
			title: "A real problem",
			failingCase: "The new line is wrong.",
		};
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("submit_review", {
							findings: [
								{ ...finding, path: "app.ts", line: 1, side: "RIGHT" },
								{ ...finding, path: "other.ts", line: 7, side: "RIGHT" },
							],
						})
					: anthropicStream("Reported."),
			{
				"api.github.com": github({ base: "release/1.x", mergeBases: [MERGE_BASE, later] }).handler,
			},
		);
		await admitted(registry);
		await vi.waitFor(async () =>
			expect((await registry.listPullRequestReviews())[0]).toMatchObject({ status: "posted" }),
		);
		// What submit_review returned to the model: the finding on the line the model read is inline
		// (offDiff false), and the one on a line only a recomputed patch has is off the diff.
		const outcome = JSON.stringify(requests[1]?.body.messages);
		const flags = [...outcome.matchAll(/offDiff[^a-z]+(true|false)/g)].map((match) => match[1]);
		// The findings come back in the order they were submitted: app.ts, then other.ts.
		expect(flags).toEqual(["false", "true"]);
	});
});

describe("a review's criteria", () => {
	it("are the title and the description, without Gateweave's checks section or AI disclosure", () => {
		const written = pullRequestBody(BODY, `## ${CHECKS_HEADING}\n\nAll passed.`, "Builder");
		expect(written).toContain("All passed.");
		expect(written).toContain("AI-Disclosure");
		expect(reviewCriteria(TITLE, written)).toEqual([TITLE, BODY]);
		expect(reviewCriteria(TITLE, "")).toEqual([TITLE]);
		// Nothing is cut: a description of any length GitHub allows is a criterion whole.
		const long = `${"a".repeat(65_000)} last`;
		expect(reviewCriteria(TITLE, long)).toEqual([TITLE, long]);
	});
});
