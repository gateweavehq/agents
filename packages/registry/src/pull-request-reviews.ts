/**
 * Reviews of the pull requests the workspace's agents opened. A `pull_request` trigger has no URL
 * and no secret: the one source of its deliveries is a run that ends having recorded a pull
 * request (`queueReviews`, called by `finishRun`), which makes one for the head the run left. The
 * registry's alarm admits each as a trigger's delivery with the id `review:<repository id>:<number>:<head>`
 * (`admitReview`), so the trigger's limits, its pause, "What came lately" and the ownership of its
 * runs are a webhook's. A delivery the workspace's sandboxes or minutes cannot take yet is queued
 * again, up to six times in a day, and not lost (`retryReview`).
 *
 * There is one review for each repository, pull request and head in the workspace, whatever the
 * number of its review triggers: the one that reviews it is chosen when the head is first seen
 * (`reviewTrigger`), and the row stays when that trigger is deleted, so a trigger that replaces it
 * does not review the head again.
 *
 * A row holds counts and where the review stands, never the findings: those stay in the review
 * conversation as the result of `submit_review`.
 */
import {
	PULL_REQUEST_EVENT,
	type PullRequestReview,
	REVIEW_RETRY_MINUTES,
	REVIEW_SKIPPED,
	type ReviewCounts,
	type ReviewPullState,
	reviewDeliveryId,
	reviewRetryAt,
	type SandboxRepository,
} from "@gateweave/agents-model";
import { and, asc, eq, isNull, lt, lte, min, or, sql } from "drizzle-orm";
import {
	agentDefinitions,
	type PullRequestReviewRow,
	pullRequestReviews,
	repositories,
	runs,
	triggerDeliveries,
} from "./db/schema";
import { reviewTrigger } from "./review-triggers";
import { RUN_TIMEOUT } from "./runs";
import type { Db } from "./state";
import { teamLead } from "./teams";
import { admitDelivery, triggerRow } from "./triggers";

/** Reviews admitted by one alarm, so a burst of them never holds the alarm for long. */
export const REVIEWS_PER_ALARM = 3;

/**
 * How long an admitted review is given to begin its run before it is admitted again, as when the
 * Worker stopped in between.
 */
const START_WITHIN = 10 * 60_000;

/** How long a review's run is waited for before the review counts as failed. */
const RUNNING_LIMIT = RUN_TIMEOUT + 10 * 60_000;

/**
 * Makes the delivery of each review trigger for the head the run left, when it recorded a pull
 * request and ended without failing or being stopped. A closed pull request, a repository the
 * workspace does not reach, and a head already queued or reviewed make none. Returns how many were
 * made.
 */
export function queueReviews(db: Db, runId: string, now: number): number {
	const run = db
		.select({ status: runs.status, pullRequest: runs.pullRequest })
		.from(runs)
		.where(eq(runs.id, runId))
		.get();
	const pull = run?.pullRequest;
	if (!run || !pull?.head) return 0;
	// A run that failed or was stopped says nothing of its branch being finished.
	if (run.status !== "succeeded" && run.status !== "step-limit") return 0;
	if (pull.state === "closed" || pull.state === "merged") return 0;
	const repository = db
		.select({ id: repositories.id })
		.from(repositories)
		.where(
			and(
				eq(repositories.provider, "github"),
				isNull(repositories.removedAt),
				sql`lower(${repositories.owner} || '/' || ${repositories.name}) = ${pull.repository.toLowerCase()}`,
			),
		)
		.get();
	if (!repository) return 0;
	const trigger = reviewTrigger(db, [], repository.id);
	if (!trigger) return 0;
	const row = triggerRow(db, trigger);
	const reviewerId = row?.agentId ?? (row?.teamId ? teamLead(db, row.teamId)?.leadAgentId : null);
	const reviewerRepository = reviewerId
		? db
				.select({ repositoryId: agentDefinitions.repositoryId })
				.from(agentDefinitions)
				.where(eq(agentDefinitions.agentId, reviewerId))
				.get()?.repositoryId
		: null;
	// A reviewer set up for one repository reviews there alone; one without a repository is the
	// older workspace-wide kind.
	if (reviewerRepository && reviewerRepository !== repository.id) return 0;
	// One row for the head in the whole workspace: the id is the primary key, so a head that was
	// queued or reviewed before, by this trigger or another that is gone, makes none.
	const queued = db
		.insert(pullRequestReviews)
		.values({
			triggerId: trigger,
			id: reviewDeliveryId(repository.id, pull.number, pull.head),
			repositoryId: repository.id,
			repository: pull.repository,
			number: pull.number,
			head: pull.head,
			sourceRunId: runId,
			status: "queued",
			draft: pull.draft === true,
			draftReason: pull.draft === true ? (pull.draftReason ?? null) : null,
			nextAttemptAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: pullRequestReviews.id })
		.get();
	return queued ? 1 : 0;
}

/** The queued reviews whose time has come, the oldest first. */
export function dueReviews(db: Db, now: number, limit: number): PullRequestReviewRow[] {
	return db
		.select()
		.from(pullRequestReviews)
		.where(and(eq(pullRequestReviews.status, "queued"), lte(pullRequestReviews.nextAttemptAt, now)))
		.orderBy(asc(pullRequestReviews.nextAttemptAt), asc(pullRequestReviews.createdAt))
		.limit(limit)
		.all();
}

/** A review as it is now, if it is still queued and its time has come. */
export function dueReview(db: Db, id: string, now: number): PullRequestReviewRow | null {
	return (
		db
			.select()
			.from(pullRequestReviews)
			.where(
				and(
					eq(pullRequestReviews.id, id),
					eq(pullRequestReviews.status, "queued"),
					lte(pullRequestReviews.nextAttemptAt, now),
				),
			)
			.get() ?? null
	);
}

/**
 * Holds a review to the pull request as GitHub has it now, read outside the registry's
 * synchronous write, before any delivery is made for it: a pull request that was closed or merged
 * since the run left it, whose branch moved on, or that is gone ends the review as skipped, and no
 * delivery, conversation or run exists for it. The draft status is GitHub's. `null`, when GitHub
 * could not be read, makes no delivery either: only GitHub's word that the pull request is open
 * at the reviewed head admits it, so the review stays queued and is read again on its next try
 * (`retryReview`, six tries over a day, then failed). True when the review may be admitted.
 */
export function holdToPull(
	db: Db,
	review: PullRequestReviewRow,
	live: ReviewPullState | "gone" | null,
	now: number,
): boolean {
	if (live === null) {
		retryReview(db, review, now, "GitHub could not confirm that the pull request is open");
		return false;
	}
	if (live === "gone") {
		skipReview(db, review, REVIEW_SKIPPED.notFound, now);
		return false;
	}
	if (live.state !== "open") {
		skipReview(db, review, REVIEW_SKIPPED.closed, now);
		return false;
	}
	if (live.head !== review.head) {
		skipReview(db, review, REVIEW_SKIPPED.headGone, now);
		return false;
	}
	if (live.draft !== review.draft) {
		db.update(pullRequestReviews)
			.set({ draft: live.draft, draftReason: live.draft ? review.draftReason : null })
			.where(sameReview(review))
			.run();
	}
	return true;
}

/**
 * When the alarm must next look at the reviews, or null when none needs it: the next queued
 * review's time, or the time the longest-running review's run is given up on, whichever is first.
 * Without the second, a review whose run never reported would stay `running` in a workspace that
 * has nothing else for the alarm to do.
 */
export function nextReviewAt(db: Db): number | null {
	const queued =
		db
			.select({ at: min(pullRequestReviews.nextAttemptAt) })
			.from(pullRequestReviews)
			.where(eq(pullRequestReviews.status, "queued"))
			.get()?.at ?? null;
	const oldest =
		db
			.select({ at: min(pullRequestReviews.updatedAt) })
			.from(pullRequestReviews)
			.where(eq(pullRequestReviews.status, "running"))
			.get()?.at ?? null;
	const expires = oldest === null ? null : oldest + RUNNING_LIMIT + 1;
	return queued === null ? expires : expires === null ? queued : Math.min(queued, expires);
}

/** Reviews whose run never reported are failed, as runs that went on too long are interrupted. */
export function expireReviews(db: Db, now: number): void {
	db.update(pullRequestReviews)
		.set({
			status: "failed",
			reason: "The review's run did not report back",
			nextAttemptAt: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(pullRequestReviews.status, "running"),
				lt(pullRequestReviews.updatedAt, now - RUNNING_LIMIT),
			),
		)
		.run();
}

/** What admitting a review's delivery came to. */
export type ReviewAdmission =
	| { status: "start"; conversationId: string; attemptId: string }
	| { status: "settled" };

/** The event a review's delivery carries, which names the pull request and its head. */
export function reviewEvent(review: PullRequestReviewRow): string {
	return JSON.stringify({
		type: PULL_REQUEST_EVENT,
		data: { repository: review.repository, number: review.number, head: review.head },
	});
}

/**
 * Admits the delivery of a queued review as a webhook's is, under the trigger's limits. A
 * delivery over them, or whose trigger is busy, is queued again; a paused trigger skips it.
 */
export function admitReview(db: Db, review: PullRequestReviewRow, now: number): ReviewAdmission {
	const trigger = review.triggerId === null ? null : triggerRow(db, review.triggerId);
	if (!trigger?.pullRequest) {
		skipReview(db, review, REVIEW_SKIPPED.paused, now);
		return { status: "settled" };
	}
	const admitted = admitDelivery(db, trigger, { id: review.id, body: reviewEvent(review) }, now);
	switch (admitted.status) {
		case "start":
			db.update(pullRequestReviews)
				.set({
					conversationId: admitted.conversationId,
					nextAttemptAt: now + START_WITHIN,
					updatedAt: now,
				})
				.where(sameReview(review))
				.run();
			return {
				status: "start",
				conversationId: admitted.conversationId,
				attemptId: admitted.attemptId,
			};
		case "limited":
			retryReview(db, review, now, admitted.message, admitted.retryAfter * 1000);
			break;
		case "starting":
			// Its run is about to begin: look again in a little while.
			db.update(pullRequestReviews)
				.set({ nextAttemptAt: now + admitted.retryAfter * 1000, updatedAt: now })
				.where(sameReview(review))
				.run();
			break;
		case "refused":
			failReview(db, review, admitted.message, now);
			break;
		case "skipped":
			skipReview(db, review, deliveryNote(db, review) ?? REVIEW_SKIPPED.paused, now);
			break;
		case "duplicate":
			skipReview(db, review, "This head was reviewed already", now);
			break;
	}
	return { status: "settled" };
}

function sameReview(review: Pick<PullRequestReviewRow, "id">) {
	return eq(pullRequestReviews.id, review.id);
}

function deliveryNote(db: Db, review: PullRequestReviewRow): string | null {
	if (review.triggerId === null) return null;
	return (
		db
			.select({ error: triggerDeliveries.error })
			.from(triggerDeliveries)
			.where(
				and(eq(triggerDeliveries.triggerId, review.triggerId), eq(triggerDeliveries.id, review.id)),
			)
			.get()?.error ?? null
	);
}

/**
 * Sends a review back to the queue because no sandbox could be had, or a limit was over: it is
 * tried again after the next wait of `REVIEW_RETRY_MINUTES`, and fails once those are used up.
 * `atLeast` is a wait the limit asked for.
 */
export function retryReview(
	db: Db,
	review: PullRequestReviewRow,
	now: number,
	reason: string,
	atLeast = 0,
): void {
	const tries = review.retries + 1;
	const at = reviewRetryAt(tries, now);
	if (at === null) {
		failReview(
			db,
			review,
			`${reason}. It was tried again ${REVIEW_RETRY_MINUTES.length} times over a day and not taken`,
			now,
		);
		return;
	}
	db.update(pullRequestReviews)
		.set({
			status: "queued",
			retries: tries,
			reason,
			nextAttemptAt: Math.max(at, now + atLeast),
			conversationId: null,
			updatedAt: now,
		})
		.where(sameReview(review))
		.run();
}

export function failReview(db: Db, review: PullRequestReviewRow, reason: string, now: number) {
	db.update(pullRequestReviews)
		.set({ status: "failed", reason, nextAttemptAt: null, updatedAt: now })
		.where(sameReview(review))
		.run();
}

/** Ends a review as never reviewed, with why, on its delivery too, so a retry starts nothing. */
export function skipReview(db: Db, review: PullRequestReviewRow, reason: string, now: number) {
	db.update(pullRequestReviews)
		.set({ status: "skipped", reason, nextAttemptAt: null, updatedAt: now })
		.where(sameReview(review))
		.run();
	if (review.triggerId === null) return;
	db.update(triggerDeliveries)
		.set({ status: "skipped", error: reason })
		.where(
			and(eq(triggerDeliveries.triggerId, review.triggerId), eq(triggerDeliveries.id, review.id)),
		)
		.run();
}

/** The review a conversation was opened for, while it is queued or running. */
export function reviewOfConversation(db: Db, conversationId: string): PullRequestReviewRow | null {
	return (
		db
			.select()
			.from(pullRequestReviews)
			.where(
				and(
					eq(pullRequestReviews.conversationId, conversationId),
					or(eq(pullRequestReviews.status, "queued"), eq(pullRequestReviews.status, "running")),
				),
			)
			.get() ?? null
	);
}

/** The repository a review's sandbox checks out, or why it cannot be. */
export function reviewRepository(
	db: Db,
	review: PullRequestReviewRow,
): SandboxRepository | { problem: string } {
	const repository = db
		.select()
		.from(repositories)
		.where(eq(repositories.id, review.repositoryId))
		.get();
	if (repository?.provider !== "github" || repository.removedAt !== null) {
		return { problem: `The workspace's GitHub App no longer reaches ${review.repository}` };
	}
	if (repository.installationId === null) {
		return { problem: `${review.repository} is not reached through the workspace's GitHub App` };
	}
	return {
		owner: repository.owner,
		name: repository.name,
		externalId: repository.externalId,
		installationId: repository.installationId,
		defaultBranch: repository.defaultBranch,
	};
}

/** Notes that the review's run began. */
export function startReview(db: Db, review: PullRequestReviewRow, runId: string, now: number) {
	db.update(pullRequestReviews)
		.set({ status: "running", runId, reason: null, nextAttemptAt: null, updatedAt: now })
		.where(sameReview(review))
		.run();
}

/** Keeps what a review found, while its run goes. False when no such run is going. */
export function recordReviewCounts(
	db: Db,
	runId: string,
	counts: ReviewCounts,
	now: number,
): boolean {
	const recorded = db
		.update(pullRequestReviews)
		.set({ ...counts, updatedAt: now })
		.where(and(eq(pullRequestReviews.runId, runId), eq(pullRequestReviews.status, "running")))
		.returning({ id: pullRequestReviews.id })
		.get();
	return recorded !== undefined;
}

/** Settles the review a run was for, as the run ends. */
export function finishReviewRun(
	db: Db,
	runId: string,
	finish: { status: string; error?: string | null },
	now: number,
): void {
	const review = db
		.select()
		.from(pullRequestReviews)
		.where(and(eq(pullRequestReviews.runId, runId), eq(pullRequestReviews.status, "running")))
		.get();
	if (!review) return;
	const ended =
		finish.status !== "succeeded"
			? { status: "failed" as const, reason: finish.error ?? `The review's run ${finish.status}` }
			: review.found === null
				? {
						status: "failed" as const,
						reason: "The review ended without submitting its findings",
					}
				: { status: "posted" as const, reason: null };
	db.update(pullRequestReviews)
		.set({ ...ended, nextAttemptAt: null, updatedAt: now })
		.where(sameReview(review))
		.run();
}

export function listReviews(db: Db): PullRequestReview[] {
	return db
		.select()
		.from(pullRequestReviews)
		.orderBy(asc(pullRequestReviews.createdAt), asc(pullRequestReviews.id))
		.all()
		.map(({ repositoryId: _, conversationId: __, ...review }) => review);
}
