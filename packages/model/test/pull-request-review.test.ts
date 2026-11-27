import { describe, expect, it } from "vitest";
import {
	REVIEW_RETRY_MINUTES,
	reviewDeliveryId,
	reviewRetryAt,
	reviewSummary,
	runPullRequest,
	triggerInput,
} from "../src";

const HEAD = "a".repeat(40);

describe("a review's delivery", () => {
	it("is named for the repository, the pull request and the head", () => {
		expect(reviewDeliveryId("repo-1", 12, HEAD)).toBe(`review:repo-1:12:${HEAD}`);
	});

	it("is tried again six times, all inside a day", () => {
		expect(REVIEW_RETRY_MINUTES).toHaveLength(6);
		expect(REVIEW_RETRY_MINUTES.reduce((sum, minutes) => sum + minutes, 0)).toBeLessThanOrEqual(
			24 * 60,
		);
		const now = 1_000_000;
		expect(reviewRetryAt(1, now)).toBe(now + 5 * 60_000);
		expect(reviewRetryAt(6, now)).toBe(now + 720 * 60_000);
		expect(reviewRetryAt(7, now)).toBeNull();
	});
});

describe("the review summary", () => {
	const counts = { found: 1, shown: 1, proven: 0, draft: false, draftReason: null };

	it("counts the findings, and says nothing of drafts for a pull request that is not one", () => {
		expect(reviewSummary(counts)).toBe("1 finding, 1 shown, 0 proven.");
	});

	it("says a draft is one, and why when the run recorded why", () => {
		expect(reviewSummary({ ...counts, draft: true, draftReason: "Its checks failed." })).toBe(
			"This pull request is a draft. Why: Its checks failed.\n\n1 finding, 1 shown, 0 proven.",
		);
		expect(reviewSummary({ ...counts, draft: true })).toContain("did not record why");
	});
});

describe("what a run records of its pull request", () => {
	const pull = {
		repository: "acme/site",
		number: 12,
		url: "https://github.com/acme/site/pull/12",
	};

	it("may carry the head, its state and whether and why it is a draft", () => {
		const recorded = { ...pull, head: HEAD, state: "open", draft: true, draftReason: "Checks." };
		expect(runPullRequest.parse(recorded)).toEqual(recorded);
		expect(runPullRequest.safeParse(pull).success).toBe(true);
		expect(runPullRequest.safeParse({ ...pull, head: "main" }).success).toBe(false);
		expect(runPullRequest.safeParse({ ...pull, state: "gone" }).success).toBe(false);
	});
});

describe("a pull request trigger", () => {
	const base = {
		name: "Review",
		prompt: "Review it",
		target: { kind: "agent" as const, agentId: "agent-1" },
	};

	it("starts on pull requests alone", () => {
		expect(triggerInput.parse({ ...base, pullRequest: true }).pullRequest).toBe(true);
		expect(triggerInput.parse(base).pullRequest).toBe(false);
		for (const more of [
			{ schedule: { cron: "0 9 * * *", timeZone: "UTC" } },
			{ events: ["issue.created"] },
			{ label: "agent" },
			{ assignee: "member-1" },
			{ perIssue: true },
		]) {
			expect(triggerInput.safeParse({ ...base, pullRequest: true, ...more }).success).toBe(false);
		}
	});
});
