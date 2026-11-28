/**
 * The data part that ties a reply to the run it came from. The chat reads the run's
 * summary from it and links to the run's page. Unlike a turn's progress parts it is not
 * transient, so the conversation keeps it and history replays it.
 */
export const RUN_PART = "data-run";

/** What a `RUN_PART` carries. */
export interface RunPartData {
	runId: string;
}
