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
	REVIEW_SKIPPED,
	reviewMessage,
} from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { pullRequestBody } from "../src/checks";
import { reviewCriteria } from "../src/review-turn";
import { type FakeSandbox, goneHeads, REVIEW_DIFF } from "./fake-sandbox";
import { anthropicStream, anthropicToolCall, fakeModel, KEY } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
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

/** GitHub as a review reads it: the pull request as JSON, and its diff for the diff media type. */
function github({
	state = "open",
	head = HEAD,
	diff = REVIEW_DIFF,
	body = BODY,
}: {
	state?: string;
	head?: string;
	diff?: string;
	body?: string;
} = {}) {
	const asked: string[] = [];
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
		if (url.pathname === "/repos/acme/site/pulls/12") {
			if (request.headers.get("accept")?.includes("diff")) return new Response(diff);
			return Response.json({
				number: 12,
				html_url: "https://github.com/acme/site/pull/12",
				title: TITLE,
				body,
				state,
				merged_at: null,
				draft: false,
				head: { sha: head, ref: "gateweave/builder" },
			});
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	};
	return { asked, handler };
}

/** A workspace whose builder left a pull request at `HEAD`, and a review agent to read it. */
async function reviewing() {
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
	const reviewer = await agent("Reviewer", true, true);
	const made = await registry.createTrigger(
		{
			name: "Review",
			prompt: "Review it",
			target: { kind: "agent", agentId: reviewer.id },
			pullRequest: true,
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

	it("ends as skipped when the pull request was closed since the run", async () => {
		const { registry } = await reviewing();
		fakeModel(() => anthropicStream("Never asked."), {
			"api.github.com": github({ state: "closed" }).handler,
		});
		expect(await admitted(registry)).toMatchObject({
			status: "skipped",
			reason: REVIEW_SKIPPED.closed,
		});
	});
});

describe("a review's criteria", () => {
	it("are the title and the description, without Gateweave's checks section or AI disclosure", () => {
		const written = pullRequestBody(BODY, `## ${CHECKS_HEADING}\n\nAll passed.`, "Builder");
		expect(written).toContain("All passed.");
		expect(written).toContain("AI-Disclosure");
		expect(reviewCriteria(TITLE, written)).toEqual([TITLE, BODY]);
		expect(reviewCriteria(TITLE, "")).toEqual([TITLE]);
	});
});
