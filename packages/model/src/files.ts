/**
 * Files only (AGT-122): a turn that works on its agent's repository without a sandbox. It reads
 * and edits the repository's files, kept in the conversation, and opens pull requests; it runs no
 * command. These are the pure parts the registry and the runtime share.
 *
 * It ships dark: the registry keeps the setting and its rules, and nothing runs such a turn yet.
 * No form offers the setting, and a deployment refuses its turns unless it says otherwise.
 */

/** What a deployment sets to run turns that work on files without a sandbox. */
export interface FilesSettings {
	/**
	 * `1` to run them. Off when unset or anything else, so a mistyped value never turns them on.
	 * Until the runtime gives such a turn its file tools, `1` only lets the turn through as one
	 * without them.
	 */
	FILES_ONLY_RUNS?: unknown;
}

/** Whether the deployment runs turns that work on files without a sandbox. */
export function filesOffered(settings: FilesSettings): boolean {
	// Wrangler passes a number in `vars` as a number.
	return String(settings.FILES_ONLY_RUNS ?? "").trim() === "1";
}

/** Why an agent set to work on files without a sandbox cannot answer where the server runs no such turn. */
export const FILES_NOT_OFFERED = "This server does not run agents on files without a sandbox yet";

/** Why an agent cannot have both: a sandbox already reads and edits the repository's files. */
export const FILES_WITH_SANDBOX =
	"An agent works on files without a sandbox or has a sandbox, not both";

/** Why an agent set to work on files without a sandbox must have a repository: there is nothing else to work on. */
export const FILES_NEED_REPOSITORY = "Files only works on a repository: choose one";

/** The model requests one turn may make: the first, and one after each round of tool calls. */
export const MAX_STEPS = 10;

/**
 * The same for a turn with a sandbox, whose work takes many small steps, and for one that works
 * on files without a sandbox, for the same reason.
 */
export const MAX_SANDBOX_STEPS = 40;
