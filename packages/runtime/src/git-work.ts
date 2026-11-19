/**
 * The git commands a sandbox proposes its work with, apart from the container that runs them
 * (`RunnerSandbox` in `./sandbox.ts`), so the tests can hold them to their rules with a git that
 * only records. The work is committed first and pushed after, as two steps: when the repository
 * has checks (`./checks.ts`), they run between the two, on the commit.
 */
import type { Comparison } from "./checks";
import type { CommitAuthor, CommitResult } from "./pull-requests";
import type { CommandResult } from "./sandbox-tools";

/**
 * Runs git in the checkout with these arguments, for at most `seconds`, with `env` added.
 * `outputLimit` bounds the output as a prefix, for output parsed whole; without it the output
 * keeps its start and end around what was left out.
 */
export type Git = (
	args: string[],
	seconds?: number,
	env?: Record<string, string>,
	outputLimit?: number,
) => Promise<CommandResult>;

/** A commit's id as `git rev-parse` prints it, in SHA-1 or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isCommitId(text: string): boolean {
	return COMMIT_ID.test(text);
}

/** The environment a commit is made with: the author, as both its author and its committer. */
export function commitEnvironment(author: CommitAuthor): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_COMMITTER_NAME: author.name,
		GIT_COMMITTER_EMAIL: author.email,
	};
}

/**
 * Commits every change in the checkout with `message`, unless there are none to commit, and says
 * which commit the work is at. Refuses when the work has no commit the default branch does not.
 * It pushes nothing.
 */
export async function commitWork(
	git: Git,
	defaultBranch: string,
	message: string,
	author: CommitAuthor,
): Promise<CommitResult> {
	const added = await git(["add", "--all"]);
	if (added.exitCode !== 0) return { error: `The changes could not be added.\n${added.output}` };
	// Exits 1 when something is staged.
	const staged = await git(["diff", "--cached", "--quiet"]);
	if (staged.exitCode === 1) {
		// The repository's own hooks run, as they would for a person.
		const committed = await git(
			["commit", "--quiet", "--message", message],
			120,
			commitEnvironment(author),
		);
		if (committed.exitCode !== 0) {
			return { error: `The changes could not be committed.\n${committed.output}` };
		}
	} else if (staged.exitCode !== 0) {
		return { error: `The changes could not be read.\n${staged.output}` };
	}
	const base = `origin/${defaultBranch}`;
	const ahead = await git(["rev-list", "--count", `${base}..HEAD`]);
	if (ahead.exitCode !== 0) {
		return { error: `The work could not be compared with ${base}.\n${ahead.output}` };
	}
	if (Number.parseInt(ahead.output.trim(), 10) === 0) {
		return {
			error: `There is nothing to propose: the work has no commit that ${defaultBranch} does not.`,
		};
	}
	const head = (await git(["rev-parse", "HEAD"])).output.trim();
	if (!isCommitId(head)) return { error: "The work's commit could not be read." };
	return { head };
}

/** Most changed files `changedSince` names; the rest are counted. */
const CHANGED_SHOWN = 20;

/**
 * Whether the checkout still is the commit `head`: null when it is; what differs, in git's words,
 * for the model to read; or why that could not be told. The repository's checks run in this
 * checkout, so a difference after one of them means that the next would run on files that are
 * not the commit's: a formatter fixed a file, a test rewrote a snapshot, or a command the agent
 * left running wrote something. Files git ignores do not count: what a build leaves behind is
 * not the work.
 *
 * What git cannot say is never taken for a clean checkout, and never for a change either.
 */
export async function changedSince(git: Git, head: string): Promise<Comparison> {
	const at = await git(["rev-parse", "HEAD"]);
	if (at.exitCode !== 0) return { unverified: "The checkout's commit could not be read." };
	if (at.output.trim() !== head) return { changed: "A new commit was made while the checks ran." };
	const status = await git([
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--ignore-submodules=none",
	]);
	if (status.exitCode !== 0) return { unverified: "The checkout's changes could not be read." };
	const changed = status.output.split("\n").filter((line) => line.trim() !== "");
	if (changed.length === 0) return null;
	const more = changed.length - CHANGED_SHOWN;
	const shown = [...changed.slice(0, CHANGED_SHOWN), ...(more > 0 ? [`and ${more} more`] : [])];
	return { changed: shown.join("\n") };
}

/**
 * The arguments of the push of the commit `head` to `branch`. It names the commit and not `HEAD`,
 * so a commit made in the checkout after `commitWork`, while the repository's checks ran, is not
 * in the push.
 */
export function pushArguments(branch: string, head: string): string[] {
	return ["push", "--porcelain", "origin", `${head}:refs/heads/${branch}`];
}
