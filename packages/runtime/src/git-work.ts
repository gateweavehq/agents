/**
 * The git commands a sandbox proposes its work with, apart from the container that runs them
 * (`RunnerSandbox` in `./sandbox.ts`), so the tests can hold them to their rules with a git that
 * only records. The work is committed first and pushed after, as two steps: when the repository
 * has checks (`./checks.ts`), they run between the two, on the commit.
 */
import type { AgentEngine } from "@gateweave/agents-model";
import type { Comparison } from "./checks";
import type { CommitAuthor, CommitResult } from "./pull-requests";
import type { CommandResult } from "./sandbox-tools";

/** Runs a command in the checkout for at most `seconds`, with `env` added. */
export type CheckoutCommand = (
	args: string[],
	seconds?: number,
	env?: Record<string, string>,
) => Promise<CommandResult>;

/** Runs git with these arguments in the checkout. */
export type Git = CheckoutCommand;

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

export function disclosureModel(model: string | null | undefined, engine: AgentEngine): string {
	return model?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim() || engine;
}

export function assistedBy(model: string): string {
	return `Assisted-by: Gateweave Agents:${disclosureModel(model, "gateweave")}`;
}

// Keep the original trees, including conflict resolutions and edits authored in a merge.
// Bash keeps the mapping inside the checkout, so even a long history takes one sandbox call.
// One walk leaves out every commit a remote-tracking ref reaches, such as a colleague's commit
// merged from main: those keep their ids, as parents map to themselves unless rewritten.
// Trees are kept as they are, so moving the branch changes neither the index nor the files.
const REWRITE_COMMITS = `
set -eo pipefail
start=$1
original=$2
commits=$(git rev-list --topo-order --reverse --parents "$original" --not "$start" --remotes)
bot=$(git var GIT_AUTHOR_IDENT)
bot=$(printf '%s\\n' "$bot" | sed 's/> .*$/>/')
declare -A rewritten

while read -r id parents; do
  [[ -n "$id" ]] || continue

  parent_args=()
  parents_unchanged=true
  for parent in $parents; do
    mapped=\${rewritten[$parent]:-$parent}
    parent_args+=(-p "$mapped")
    if [[ "$mapped" != "$parent" ]]; then parents_unchanged=false; fi
  done
  identities=$(git show -s --no-notes --no-show-signature --format='%an <%ae>%n%cn <%ce>' "$id")
  trailers=$(git show -s --no-notes --no-show-signature --format='%(trailers:key=Assisted-by)' "$id")
  if grep -Fxq -- "$GATEWEAVE_ASSISTED_BY" <<< "$trailers"; then
    if "$parents_unchanged" && [[ "$identities" == "$bot"$'\\n'"$bot" ]]; then
      rewritten[$id]=$id
      continue
    fi
    message_filter=(cat)
  else
    # A commit message has no patch, so a "---" line in it is text, not where trailers end.
    message_filter=(git interpret-trailers --no-divider --where end --if-exists add --if-missing add --trailer "$GATEWEAVE_ASSISTED_BY")
  fi

  tree=$(git rev-parse "$id^{tree}")
  date=$(git show -s --no-notes --no-show-signature --format=%aI "$id")
  rewritten[$id]=$(git show -s --no-notes --no-show-signature --format=format:%B "$id" |
    "\${message_filter[@]}" |
    GIT_AUTHOR_DATE="$date" git commit-tree "$tree" "\${parent_args[@]}" --no-gpg-sign)
done <<< "$commits"

head=\${rewritten[$original]:-$original}
git -c core.hooksPath=/dev/null update-ref HEAD "$head" "$original"
printf '%s\\n' "$head"
`;

/**
 * Commits every change in the checkout with `message`, unless there are none to commit, and says
 * which commit the work is at. Refuses when the work has no commit the default branch does not.
 * It pushes nothing.
 */
export async function commitWork(
	run: CheckoutCommand,
	defaultBranch: string,
	message: string,
	author: CommitAuthor,
	model: string,
	lastPushed: string | null = null,
): Promise<CommitResult> {
	const git: Git = (args, seconds, env) => run(["git", ...args], seconds, env);
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
	const markingError = (output: string): CommitResult => ({
		error: `The work's commits could not be marked as written by an agent.\n${output}`,
	});
	// If the remote is unavailable, the checkout's refs still protect work it already fetched.
	await git(
		["fetch", "--quiet", "origin", `+refs/heads/${defaultBranch}:refs/remotes/${base}`],
		300,
	).catch(() => null);
	const at = await git(["rev-parse", "HEAD"]);
	const original = at.output.trim();
	if (at.exitCode !== 0 || !isCommitId(original)) {
		return { error: "The work's commit could not be read." };
	}
	const ahead = await git(["rev-list", "--count", `${base}..${original}`]);
	if (ahead.exitCode !== 0) {
		return { error: `The work could not be compared with ${base}.\n${ahead.output}` };
	}
	if (Number.parseInt(ahead.output.trim(), 10) === 0) {
		return {
			error: `There is nothing to propose: the work has no commit that ${defaultBranch} does not.`,
		};
	}
	let start = lastPushed;
	if (
		start === null ||
		(await git(["merge-base", "--is-ancestor", start, original])).exitCode !== 0
	) {
		const mergeBase = await git(["merge-base", base, original]);
		start = mergeBase.output.trim();
		if (mergeBase.exitCode !== 0 || !isCommitId(start)) return markingError(mergeBase.output);
	}
	try {
		// Checks and the outbound push both use the resulting head, so marking ends here.
		const marked = await run(
			["bash", "-c", REWRITE_COMMITS, "rewrite-commits", start, original],
			300,
			{
				...commitEnvironment(author),
				GATEWEAVE_ASSISTED_BY: assistedBy(model),
			},
		);
		if (marked.exitCode !== 0) return markingError(marked.output);
		const head = marked.output.trim();
		return isCommitId(head) ? { head } : markingError(marked.output);
	} catch (error) {
		return markingError(error instanceof Error ? error.message : String(error));
	}
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
