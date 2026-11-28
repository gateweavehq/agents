/**
 * A repository's checks: shell commands an owner or admin sets on the repository's page,
 * such as `pnpm check` and `pnpm test`. When an agent proposes its work on that repository,
 * `open_pull_request` runs them in the sandbox on the work as committed, before it pushes anything,
 * and writes what ran at the end of the pull request. These are the pure parts the registry, the
 * runtime and the app share.
 *
 * The commands are the workspace's settings and nothing else: no file in the repository names
 * them yet, so what an agent wrote in its working tree, or an issue's text, never decides what
 * runs.
 */
import { z } from "zod";

/** The limits of a repository's checks, which need no person to keep. */
export const CHECK_LIMITS = {
	/** Commands a repository can have, and characters of each. */
	commands: 5,
	commandLength: 300,
	/** Seconds one command may run before it is stopped. */
	commandSeconds: 10 * 60,
	/** Seconds the checks of one `open_pull_request` call may run together. */
	callSeconds: 20 * 60,
	/** Seconds the checks of all of a run's calls may run together. */
	runSeconds: 40 * 60,
	/** Bytes of the end of a failed command's output that the model reads. */
	outputBytes: 4_000,
	/** Rounds that may fail in one run; at the last, the pull request is opened as a draft. */
	failedRounds: 3,
} as const;

/**
 * The heading of the section `open_pull_request` writes at the end of a pull request when the
 * repository has checks. The words are the tool's: a copy of the heading in what the model wrote
 * is taken out before the tool's own section goes in.
 */
export const CHECKS_HEADING = "Checks run by Gateweave";

/** Why a command is refused when it has a line break or another control character. */
export const CHECK_ONE_LINE = "A check is one line, without control characters";

/**
 * Whether `text` has a control character: a line break, a tab, an escape, or one of Unicode's two
 * line separators, which a page shows as a break too. Bash would read a line break as the end of
 * one command and the start of another, and the pull request lists each command on a line.
 */
function hasControlCharacter(text: string): boolean {
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
			return true;
		}
	}
	return false;
}

/** One check: a bash command line, run in the repository's root. */
export const checkCommand = z
	.string()
	.max(CHECK_LIMITS.commandLength, `A check is at most ${CHECK_LIMITS.commandLength} characters`)
	.refine((command) => !hasControlCharacter(command), CHECK_ONE_LINE)
	.refine((command) => command.trim() !== "", "A check cannot be empty")
	.transform((command) => command.trim());

/** A repository's checks, in the order they run. None means no checks. */
export const repositoryChecksInput = z
	.array(checkCommand)
	.max(CHECK_LIMITS.commands, `A repository has at most ${CHECK_LIMITS.commands} checks`);

export type RepositoryChecksInput = z.input<typeof repositoryChecksInput>;
