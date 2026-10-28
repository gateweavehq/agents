import { and, asc, eq, isNull, lte, min, sql } from "drizzle-orm";
import { repositories, type ScanRequestRow, scanRequests } from "./db/schema";
import type { Db } from "./state";

/** Waits after the first, second and third failed try. The request is dropped after that. */
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;

/**
 * Queues a scan of each live repository, or moves its waiting request to the front. A forced
 * scan reads the repository even if nothing was pushed since the last one.
 */
export function requestScans(
	db: Db,
	repositoryIds: Iterable<string>,
	now: number,
	force = false,
): number {
	let queued = 0;
	for (const repositoryId of new Set(repositoryIds)) {
		const live = db
			.select({ id: repositories.id })
			.from(repositories)
			.where(and(eq(repositories.id, repositoryId), isNull(repositories.removedAt)))
			.get();
		if (!live) continue;
		const fields = { requestedAt: now, attempts: 0, notBefore: now };
		db.insert(scanRequests)
			.values({ repositoryId, ...fields, force })
			.onConflictDoUpdate({
				target: scanRequests.repositoryId,
				// A waiting forced request stays forced.
				set: { ...fields, force: sql`max(${scanRequests.force}, excluded.force)` },
			})
			.run();
		queued++;
	}
	return queued;
}

/** The requests whose time has come, oldest first. */
export function dueScans(db: Db, now: number, limit: number): ScanRequestRow[] {
	return db
		.select()
		.from(scanRequests)
		.where(lte(scanRequests.notBefore, now))
		.orderBy(asc(scanRequests.notBefore), asc(scanRequests.requestedAt))
		.limit(limit)
		.all();
}

/** When the next request is due, or null when none waits. */
export function nextScanAt(db: Db): number | null {
	return (
		db
			.select({ at: min(scanRequests.notBefore) })
			.from(scanRequests)
			.get()?.at ?? null
	);
}

/**
 * Drops a request once its scan is over. A request made again while the scan ran is newer than
 * what the scan read, so it stays.
 */
export function finishScan(db: Db, request: ScanRequestRow): void {
	db.delete(scanRequests)
		.where(
			and(
				eq(scanRequests.repositoryId, request.repositoryId),
				eq(scanRequests.requestedAt, request.requestedAt),
			),
		)
		.run();
}

/** Schedules another try after a failure, or drops the request after the last one. */
export function retryScan(db: Db, request: ScanRequestRow, now: number): void {
	const delay = RETRY_DELAYS_MS[request.attempts];
	if (delay === undefined) {
		finishScan(db, request);
		return;
	}
	db.update(scanRequests)
		.set({ attempts: request.attempts + 1, notBefore: now + delay })
		.where(
			and(
				eq(scanRequests.repositoryId, request.repositoryId),
				eq(scanRequests.requestedAt, request.requestedAt),
			),
		)
		.run();
}
