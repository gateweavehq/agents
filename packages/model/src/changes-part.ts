/**
 * The data part that sums up what a turn changed in its sandbox's repository (AGT-139). The chat
 * draws the files under the reply, each with its diff. Like a reply's run part it is not
 * transient, so the conversation keeps it and history replays it.
 */
export const CHANGES_PART = "data-changes";

/** One changed file, with its line counts and its diff as text. */
export interface ChangesFile {
	/** The file's path from the repository's root. */
	path: string;
	added: number;
	deleted: number;
	/** The file's diff, capped; empty for a binary file. */
	diff: string;
}

/** What a `CHANGES_PART` carries. */
export interface ChangesPartData {
	files: ChangesFile[];
	/** Whether the bounds cut files or diff text away. */
	truncated: boolean;
}
