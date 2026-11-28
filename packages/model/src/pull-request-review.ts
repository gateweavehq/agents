/**
 * The review of a pull request an agent opened: when it starts and what the registry keeps of it.
 * A review agent has a trigger of the kind `pull_request`. It has no URL and no secret to post
 * to: when a run that recorded a pull request ends, the registry makes one delivery for the head
 * the run left, and its alarm admits it under the trigger's limits. The review's findings stay in
 * the review conversation, as the result of `submit_review`; the registry keeps counts only.
 */
import { z } from "zod";
import { REVIEW_LIMITS } from "./review";
import type { SandboxRepository } from "./sandbox";

/** Where a review stands. */
export const PULL_REQUEST_REVIEW_STATUSES = [
	/** Waiting to be admitted, or to be tried again because no sandbox was free. */
	"queued",
	/** Its run began. */
	"running",
	/** Its run ended with the counts of what it found, which the review conversation holds. */
	"posted",
	/** It could not run, or its run ended without findings. */
	"failed",
	/** It was never reviewed, and `reason` says why. */
	"skipped",
] as const;
export type PullRequestReviewStatus = (typeof PULL_REQUEST_REVIEW_STATUSES)[number];

/** The `type` of the event a review's delivery starts with. */
export const PULL_REQUEST_EVENT = "pull_request";

/**
 * A delivery refused because the workspace's sandboxes are in use, or its minutes are, is tried
 * again after each of these waits, in minutes: six times in about twenty-two hours, inside the
 * day a review stays worth reading.
 */
export const REVIEW_RETRY_MINUTES = [5, 15, 60, 180, 360, 720] as const;

/** When a delivery tried `tries` times is tried next, or null when it has used its retries. */
export function reviewRetryAt(tries: number, now: number): number | null {
	const wait = REVIEW_RETRY_MINUTES[tries - 1];
	return wait === undefined ? null : now + wait * 60_000;
}

/**
 * The longest message a review turn may begin with, the one limit the runtime and the registry
 * share. It is the whole envelope `reviewMessage` can make of what a pull request may hold: a diff
 * of up to `REVIEW_LIMITS.diffBytes` bytes (its UTF-16 length is never more) and the note of what
 * was left out of it; the fence on each side, which is as long as the longest run of backticks or
 * tildes in the patch needs and never more than half the patch; a title of at most 256 characters
 * and a description of at most 65,536 characters, which GitHub allows, counted in UTF-16 units, so
 * twice over; and the headings and numbering around them.
 */
export const REVIEW_MESSAGE_LIMIT =
	REVIEW_LIMITS.diffBytes +
	64 +
	2 * (Math.floor(REVIEW_LIMITS.diffBytes / 2) + 1) +
	2 * (256 + 65_536) +
	256;

/** The id of a review's delivery: one for each repository, pull request and head. */
export function reviewDeliveryId(repositoryId: string, number: number, head: string): string {
	return `review:${repositoryId}:${number}:${head}`;
}

/** Why a review is skipped, in the words the registry keeps. */
export const REVIEW_SKIPPED = {
	closed: "The pull request is closed",
	notFound: "The pull request was not found on GitHub",
	headGone: "The reviewed head is no longer the pull request's head on GitHub",
	tooLarge: "The diff is too large to review",
	paused: "The trigger was paused",
} as const;

/** What a review found, as the registry keeps it: counts only. */
export const reviewCounts = z.object({
	found: z.number().int().min(0).max(1000),
	shown: z.number().int().min(0).max(1000),
	proven: z.number().int().min(0).max(1000),
});
export type ReviewCounts = z.infer<typeof reviewCounts>;

/**
 * The pull request as GitHub has it when a review is about to begin: whether it is still open, the
 * commit its branch is at, and whether it is a draft.
 */
export interface ReviewPullState {
	state: "open" | "closed" | "merged";
	head: string;
	draft: boolean;
}

/**
 * One review of a pull request's head, made once for the workspace by one of its review triggers.
 * Its trigger is gone (null) when it was deleted after the review began or ended: the row stays,
 * so a head that was reviewed is not reviewed again by the trigger that replaced it.
 */
export interface PullRequestReview {
	triggerId: string | null;
	/** The delivery's id (`reviewDeliveryId`). */
	id: string;
	/** `owner/name`. */
	repository: string;
	number: number;
	head: string;
	/** The review's own run, once it began. */
	runId: string | null;
	/** The run of the builder's that left this head. */
	sourceRunId: string;
	status: PullRequestReviewStatus;
	/** Why it was skipped or failed, or why it waits to be tried again. */
	reason: string | null;
	/** Whether GitHub says the pull request is a draft: as the run left it, then as read before the review. */
	draft: boolean;
	/** Why it is a draft, from the check status and changed files the run recorded; never command output. */
	draftReason: string | null;
	found: number | null;
	shown: number | null;
	proven: number | null;
	/** How many times it was refused for want of a sandbox and tried again. */
	retries: number;
	nextAttemptAt: number | null;
	createdAt: number;
	updatedAt: number;
}

/**
 * The review summary's opening: how many findings it holds, and when the pull request is a draft,
 * that it is one and why, so a reader knows the agent's own checks or edits are the reason.
 */
export function reviewSummary({
	found,
	shown,
	proven,
	draft,
	draftReason,
}: Pick<PullRequestReview, "found" | "shown" | "proven" | "draft" | "draftReason">): string {
	const lines: string[] = [];
	if (draft) {
		const why = draftReason?.trim();
		lines.push(
			why
				? `This pull request is a draft. Why: ${why}`
				: "This pull request is a draft, and the run that opened it did not record why.",
		);
	}
	lines.push(
		found === null
			? "The review has no findings recorded."
			: `${found} ${found === 1 ? "finding" : "findings"}, ${shown ?? found} shown, ${proven ?? 0} proven.`,
	);
	return lines.join("\n\n");
}

/** What the runtime reads of a review's delivery to begin it: where, which pull request and head. */
export interface ReviewDelivery {
	repository: SandboxRepository;
	number: number;
	head: string;
	draft: boolean;
	draftReason: string | null;
}
