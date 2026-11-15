/**
 * The reference a failure was logged under, if its message has one, as a failed database query's
 * does (`DatabaseError` in `server/db/query-failure.ts`). It is all of an error that a page
 * shows: eight hex characters, which say nothing by themselves and find the line in the log.
 */
export function referenceIn(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	return /\(reference ([0-9a-f]{8})\)/.exec(error.message)?.[1];
}
