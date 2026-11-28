/**
 * Which review trigger reviews a head, and what becomes of reviews when triggers are deleted. Kept
 * apart from `./pull-request-reviews.ts`, which admits deliveries through `./triggers.ts`, so that
 * deleting a trigger can let go of its reviews.
 */
import { and, asc, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { agentDefinitions, pullRequestReviews, triggers } from "./db/schema";
import type { Db } from "./state";
import { teamLead } from "./teams";

/**
 * The review trigger that reviews a head, chosen the same way each time: one that is on before
 * one that is paused, then the oldest, then the lowest id. Null when the workspace has none.
 * `except` leaves out triggers that are going away.
 */
export function reviewTrigger(db: Db, except: string[] = [], repositoryId?: string): string | null {
	const rows = db
		.select({ id: triggers.id, agentId: triggers.agentId, teamId: triggers.teamId })
		.from(triggers)
		.where(
			and(
				eq(triggers.pullRequest, true),
				except.length > 0 ? notInArray(triggers.id, except) : undefined,
			),
		)
		.orderBy(desc(triggers.active), asc(triggers.createdAt), asc(triggers.id))
		.all();
	for (const row of rows) {
		if (repositoryId === undefined) return row.id;
		const agentId = row.agentId ?? (row.teamId ? teamLead(db, row.teamId)?.leadAgentId : null);
		const bound = agentId
			? db
					.select({ repositoryId: agentDefinitions.repositoryId })
					.from(agentDefinitions)
					.where(eq(agentDefinitions.agentId, agentId))
					.get()?.repositoryId
			: null;
		// A reviewer without a repository is the older workspace-wide kind; a bound one reviews its own.
		if (!bound || bound === repositoryId) return row.id;
	}
	return null;
}

/**
 * Lets go of the reviews of triggers that are being deleted. A review that waits moves to the
 * trigger that now reviews, or goes with the last one; one that began or ended stays, with no
 * trigger, so its head counts as reviewed.
 */
export function releaseReviews(db: Db, triggerIds: string[]): void {
	if (triggerIds.length === 0) return;
	const own = inArray(pullRequestReviews.triggerId, triggerIds);
	const waiting = db
		.select({ id: pullRequestReviews.id, repositoryId: pullRequestReviews.repositoryId })
		.from(pullRequestReviews)
		.where(and(own, eq(pullRequestReviews.status, "queued")))
		.all();
	for (const review of waiting) {
		const next = reviewTrigger(db, triggerIds, review.repositoryId);
		if (next === null) {
			db.delete(pullRequestReviews).where(eq(pullRequestReviews.id, review.id)).run();
		} else {
			db.update(pullRequestReviews)
				.set({ triggerId: next, conversationId: null })
				.where(eq(pullRequestReviews.id, review.id))
				.run();
		}
	}
	db.update(pullRequestReviews)
		.set({ triggerId: null })
		.where(and(own, ne(pullRequestReviews.status, "queued")))
		.run();
}
