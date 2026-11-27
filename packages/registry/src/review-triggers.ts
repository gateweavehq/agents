/**
 * Which review trigger reviews a head, and what becomes of reviews when triggers are deleted. Kept
 * apart from `./pull-request-reviews.ts`, which admits deliveries through `./triggers.ts`, so that
 * deleting a trigger can let go of its reviews.
 */
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { pullRequestReviews, triggers } from "./db/schema";
import type { Db } from "./state";

/**
 * The review trigger that reviews a head, chosen the same way each time: one that is on before
 * one that is paused, then the oldest, then the lowest id. Null when the workspace has none.
 * `except` leaves out triggers that are going away.
 */
export function reviewTrigger(db: Db, except: string[] = []): string | null {
	return (
		db
			.select({ id: triggers.id })
			.from(triggers)
			.where(
				and(
					eq(triggers.pullRequest, true),
					except.length > 0 ? notInArray(triggers.id, except) : undefined,
				),
			)
			.orderBy(desc(triggers.active), asc(triggers.createdAt), asc(triggers.id))
			.limit(1)
			.get()?.id ?? null
	);
}

/**
 * Lets go of the reviews of triggers that are being deleted. A review that waits moves to the
 * trigger that now reviews, or goes with the last one; one that began or ended stays, with no
 * trigger, so its head counts as reviewed.
 */
export function releaseReviews(db: Db, triggerIds: string[]): void {
	if (triggerIds.length === 0) return;
	const next = reviewTrigger(db, triggerIds);
	const own = inArray(pullRequestReviews.triggerId, triggerIds);
	if (next === null) {
		db.delete(pullRequestReviews)
			.where(and(own, eq(pullRequestReviews.status, "queued")))
			.run();
	} else {
		db.update(pullRequestReviews)
			.set({ triggerId: next, conversationId: null })
			.where(and(own, eq(pullRequestReviews.status, "queued")))
			.run();
	}
	db.update(pullRequestReviews).set({ triggerId: null }).where(own).run();
}
