import { and, asc, eq, lte, min } from "drizzle-orm";
import { trackReportOutbox as outbox } from "./db/schema";
import type { Db } from "./state";
import { reportDestination, type TrackReport } from "./track-reports";

const REPORT_LIFETIME = 24 * 60 * 60_000;
const ATTEMPT_LEASE = 30_000;
const RETRY_DELAY = 15_000;
const MAX_RETRY_DELAY = 15 * 60_000;

export type PendingTrackReport = typeof outbox.$inferSelect;

/** Persist the snapshot with the run change and reserve its first send for the caller. */
export function queueTrackReport(db: Db, report: TrackReport, now: number) {
	if (!reportDestination(db, report.target)) return undefined;
	return db
		.insert(outbox)
		.values({
			id: `${report.key}:${report.sentAt}`,
			destinationId: report.target.destinationId,
			report,
			attempts: 1,
			nextAttemptAt: now + ATTEMPT_LEASE,
			expiresAt: now + REPORT_LIFETIME,
		})
		.onConflictDoNothing()
		.returning()
		.get();
}

export function nextTrackReportAt(db: Db): number | null {
	return (
		db
			.select({ at: min(outbox.nextAttemptAt) })
			.from(outbox)
			.get()?.at ?? null
	);
}

/** Reserve the next sends before starting I/O, including sends whose previous lease expired. */
export function takeDueTrackReports(db: Db, now: number, limit: number): PendingTrackReport[] {
	db.delete(outbox)
		.where(and(lte(outbox.nextAttemptAt, now), lte(outbox.expiresAt, now)))
		.run();
	const due = db
		.select()
		.from(outbox)
		.where(lte(outbox.nextAttemptAt, now))
		.orderBy(asc(outbox.nextAttemptAt))
		.limit(limit)
		.all();
	return due.map((entry) => {
		const attempt = {
			attempts: entry.attempts + 1,
			nextAttemptAt: Math.min(now + ATTEMPT_LEASE, entry.expiresAt),
		};
		db.update(outbox).set(attempt).where(eq(outbox.id, entry.id)).run();
		return { ...entry, ...attempt };
	});
}

/** A late answer must not settle a newer send of the same snapshot. */
export function settleTrackReport(
	db: Db,
	entry: PendingTrackReport,
	retryAfter: number | null,
	now: number,
): void {
	const current = and(eq(outbox.id, entry.id), eq(outbox.attempts, entry.attempts));
	if (retryAfter === null || entry.expiresAt <= now) {
		db.delete(outbox).where(current).run();
		return;
	}
	const backoff = Math.min(RETRY_DELAY * 2 ** (entry.attempts - 1), MAX_RETRY_DELAY);
	const nextAttemptAt = Math.min(entry.expiresAt, now + Math.max(backoff, retryAfter));
	db.update(outbox).set({ nextAttemptAt }).where(current).run();
}

/** Track sends Retry-After in seconds on 429 or while a workspace move holds its source. */
export function retryTrackReport(response: Response): number | null {
	const status = response.status;
	if (status !== 408 && status !== 429 && status < 500) return null;
	const retryAfter = response.headers.get("retry-after");
	return retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
}
