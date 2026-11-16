// Writing to a repository with an installation token: a commit on top of a branch's head, a
// branch that points at it, and the pull request that proposes it. Files go into the new tree as
// content, so a commit takes two requests however many files it changes.
import { z } from "zod";
import { GitHubError, request } from "./app";
import { gitBlobId, type RepositoryName, TREE_MODES, type TreeItem } from "./contents";
import { encoder } from "./encoding";
import { repositoryPathProblem, WORKFLOWS_FOLDER } from "./paths";

export interface FileChange {
	path: string;
	content: string;
	/** `100755` for a file that can be run. Left out, the file is a plain one, `100644`. */
	mode?: "100644" | "100755";
}

/** Who a commit is by. Left out, GitHub names the token's own account. */
export interface CommitAuthor {
	name: string;
	email: string;
}

export interface CommitInput {
	/** The commit the new one follows, and its tree, which keeps every file not changed. */
	parent: string;
	tree: string;
	files: readonly FileChange[];
	/** Paths taken out of the tree. GitHub refuses one that is not in it. */
	deleted?: readonly string[];
	message: string;
	author?: CommitAuthor;
}

/** A change to put on a branch without git: see `commitChanges`. */
export interface ChangesInput {
	branch: string;
	/**
	 * The commit the branch has to be at: the one this caller last put there, or null when the
	 * branch must not exist yet. At anything else, nothing is written.
	 */
	expected: string | null;
	/**
	 * The commit the files were read at, its tree, and that tree's entries (`readTreeEntries`,
	 * not truncated). `files` and `deleted` are the whole difference from this tree, however many
	 * commits the branch already holds.
	 */
	base: { commit: string; tree: string; entries: readonly TreeItem[] };
	/** New files, and files whose text is not the base's, each as it should now read. */
	files: readonly { path: string; content: string }[];
	/** Files of the base that are gone. */
	deleted: readonly string[];
	message: string;
	author?: CommitAuthor;
	/**
	 * Whether the token may write workflows: the app holds the Workflows permission and the token
	 * was not made without it. Unless it is true, a path under `.github/workflows` is refused
	 * here, before GitHub is asked.
	 */
	workflows?: boolean;
}

/** What became of a change. Every refusal is a value, so a caller can answer each in words. */
export type ChangesOutcome =
	| { committed: true; commit: string }
	/** The branch already holds exactly these files, or nothing differs from the base. */
	| { committed: false; reason: "nothing" }
	/** The branch is not where the caller expected it: `found` is its tip, null when it is gone. */
	| { committed: false; reason: "branch"; found: string | null }
	/** A path that cannot be written this way. Nothing was asked of GitHub. */
	| { committed: false; reason: "path"; path: string; message: string }
	/** GitHub refused: its status (0 when it could not be reached) and what it said. */
	| { committed: false; reason: "refused"; status: number; message: string };

export interface PullRequest {
	number: number;
	url: string;
	state: "open" | "closed" | "merged";
	/** The commit the pull request's branch is at. */
	head: string;
}

const objectId = z.string().regex(/^[0-9a-f]{40}$/);
const shaSchema = z.object({ sha: objectId });
const refSchema = z.object({ object: z.object({ sha: objectId }) });
const commitSchema = z.object({ tree: z.object({ sha: objectId }) });
const pullSchema = z.object({
	number: z.number().int().positive(),
	html_url: z.string().url(),
	state: z.enum(["open", "closed"]),
	merged: z.boolean().optional(),
	merged_at: z.string().nullable().optional(),
	head: z.object({ sha: objectId }),
});

function repositoryPath({ owner, name }: RepositoryName) {
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** `heads/<branch>`, with each part of a branch name that holds slashes encoded on its own. */
function headRef(branch: string) {
	return `heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

function toPullRequest(found: z.infer<typeof pullSchema>): PullRequest {
	// The list and webhook payloads may leave out `merged`; `merged_at` is always there.
	const merged = found.merged ?? (found.merged_at !== null && found.merged_at !== undefined);
	return {
		number: found.number,
		url: found.html_url,
		state: found.state === "open" ? "open" : merged ? "merged" : "closed",
		head: found.head.sha,
	};
}

/** Commits the files on top of `parent` and returns the new commit. No branch moves yet. */
export async function createCommit(
	token: string,
	repository: RepositoryName,
	input: CommitInput,
): Promise<string> {
	return commitTree(token, repository, await createTree(token, repository, input), input);
}

/** The base tree with the files written into it and the deleted paths taken out. */
async function createTree(
	token: string,
	repository: RepositoryName,
	input: Pick<CommitInput, "tree" | "files" | "deleted">,
): Promise<string> {
	const tree = shaSchema.parse(
		await request(`${repositoryPath(repository)}/git/trees`, token, {
			method: "POST",
			body: JSON.stringify({
				base_tree: objectId.parse(input.tree),
				tree: [
					...input.files.map((file) => ({
						path: file.path,
						mode: file.mode ?? TREE_MODES.file,
						type: "blob",
						content: file.content,
					})),
					// A null id takes the path out of the tree.
					...(input.deleted ?? []).map((path) => ({
						path,
						mode: TREE_MODES.file,
						type: "blob",
						sha: null,
					})),
				],
			}),
		}),
	);
	return tree.sha;
}

async function commitTree(
	token: string,
	repository: RepositoryName,
	tree: string,
	input: Pick<CommitInput, "parent" | "message" | "author">,
): Promise<string> {
	const commit = shaSchema.parse(
		await request(`${repositoryPath(repository)}/git/commits`, token, {
			method: "POST",
			body: JSON.stringify({
				message: input.message,
				tree,
				parents: [objectId.parse(input.parent)],
				// GitHub takes the committer from the author when only the author is given.
				...(input.author ? { author: input.author } : {}),
			}),
		}),
	);
	return commit.sha;
}

/**
 * Puts a change on a branch with no git anywhere: a tree on top of the base's, a commit, then
 * the branch made, or moved forward and never forced. The branch is the caller's alone, so it
 * has to be where the caller left it; a commit anyone else put there is not built on and not
 * dropped. A file keeps the mode the base gives it, so an executable one stays executable, and
 * a new file is a plain one. A symlink or a submodule is never written over or taken out.
 *
 * Refusals come back as values. Only an answer of GitHub's that makes no sense is thrown.
 */
export async function commitChanges(
	token: string,
	repository: RepositoryName,
	input: ChangesInput,
): Promise<ChangesOutcome> {
	const planned = await planChanges(input);
	if ("reason" in planned) return planned;
	const changed = planned.files.length > 0 || planned.deleted.length > 0;
	if (!changed && input.expected === null) return { committed: false, reason: "nothing" };

	let commit: string;
	try {
		const tip = await branchCommit(token, repository, input.branch);
		if (tip !== input.expected) return { committed: false, reason: "branch", found: tip };
		// The base's tree, not the branch's: the changes are the whole difference from the base,
		// so what an earlier commit on the branch did is in them already.
		const tree = changed
			? await createTree(token, repository, { tree: input.base.tree, ...planned })
			: objectId.parse(input.base.tree);
		if (input.expected !== null) {
			const held = commitSchema.parse(
				await request(
					`${repositoryPath(repository)}/git/commits/${objectId.parse(input.expected)}`,
					token,
				),
			);
			if (held.tree.sha === tree) return { committed: false, reason: "nothing" };
		}
		commit = await commitTree(token, repository, tree, {
			parent: input.expected ?? input.base.commit,
			message: input.message,
			author: input.author,
		});
	} catch (error) {
		if (error instanceof GitHubError) return refusal(error);
		throw error;
	}

	try {
		if (input.expected === null) await createBranch(token, repository, input.branch, commit);
		else await moveBranch(token, repository, input.branch, commit, false);
	} catch (error) {
		if (!(error instanceof GitHubError)) throw error;
		// GitHub holds the same line between the read above and here: the name is taken, or the
		// move is not a fast-forward. Which it was is read from the branch, not from GitHub's words.
		try {
			const tip = await branchCommit(token, repository, input.branch);
			if (tip !== input.expected) return { committed: false, reason: "branch", found: tip };
		} catch {
			// The refusal that came first says more than a failed second look.
		}
		return refusal(error);
	}
	return { committed: true, commit };
}

function refusal(error: GitHubError): ChangesOutcome {
	return { committed: false, reason: "refused", status: error.status, message: error.message };
}

/**
 * The entries to send for a change, or the path that cannot be sent. A file whose text is the
 * base's own is left out, so a change that changes nothing asks GitHub for nothing.
 */
async function planChanges(
	input: ChangesInput,
): Promise<
	{ files: FileChange[]; deleted: string[] } | Extract<ChangesOutcome, { reason: "path" }>
> {
	const entries = new Map(input.base.entries.map((entry) => [entry.path, entry]));
	const folders = new Set<string>();
	for (const path of entries.keys()) {
		for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
			folders.add(path.slice(0, end));
		}
	}
	const refuse = (path: string, message: string) =>
		({ committed: false, reason: "path", path, message }) as const;
	const special = (entry: TreeItem | undefined) =>
		entry?.mode === TREE_MODES.symlink
			? "a symlink"
			: entry?.mode === TREE_MODES.submodule
				? "a submodule"
				: null;
	const seen = new Set<string>();
	/** What holds for a written and a deleted path alike. */
	const problem = (path: string): string | null => {
		const malformed = repositoryPathProblem(path);
		if (malformed) return malformed;
		if (seen.has(path)) return "is named twice in one change";
		seen.add(path);
		const kind = special(entries.get(path));
		if (kind) return `is ${kind}, which is left as it is`;
		if (!input.workflows && path.startsWith(WORKFLOWS_FOLDER)) {
			return "is a workflow, which GitHub takes only from an app with the Workflows permission";
		}
		return null;
	};

	const files: FileChange[] = [];
	for (const file of input.files) {
		const found = problem(file.path);
		if (found) return refuse(file.path, found);
		if (folders.has(file.path)) return refuse(file.path, "is a folder in the repository");
		for (let end = file.path.lastIndexOf("/"); end > 0; end = file.path.lastIndexOf("/", end - 1)) {
			const above = entries.get(file.path.slice(0, end));
			if (above) {
				const kind = special(above) ?? "a file";
				return refuse(file.path, `is under ${above.path}, which is ${kind} in the repository`);
			}
		}
		const entry = entries.get(file.path);
		if (entry && entry.id === (await gitBlobId(encoder.encode(file.content)))) continue;
		files.push({
			path: file.path,
			content: file.content,
			mode: entry?.mode === TREE_MODES.executable ? TREE_MODES.executable : TREE_MODES.file,
		});
	}
	const deleted: string[] = [];
	for (const path of input.deleted) {
		const found = problem(path);
		if (found) return refuse(path, found);
		if (!entries.has(path)) return refuse(path, "is not a file in the repository");
		deleted.push(path);
	}
	return { files, deleted };
}

/** The commit a branch points to, or null when there is no such branch. */
export async function branchCommit(
	token: string,
	repository: RepositoryName,
	branch: string,
): Promise<string | null> {
	try {
		const found = refSchema.parse(
			await request(`${repositoryPath(repository)}/git/ref/${headRef(branch)}`, token),
		);
		return found.object.sha;
	} catch (error) {
		if (error instanceof GitHubError && error.status === 404) return null;
		throw error;
	}
}

/** Creates a branch at a commit. GitHub refuses a name that is taken. */
export async function createBranch(
	token: string,
	repository: RepositoryName,
	branch: string,
	commit: string,
): Promise<void> {
	await request(`${repositoryPath(repository)}/git/refs`, token, {
		method: "POST",
		body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: objectId.parse(commit) }),
	});
}

/**
 * Points a branch at another commit. Without `force`, GitHub refuses anything but a fast-forward,
 * so commits someone else pushed are never dropped by accident.
 */
export async function moveBranch(
	token: string,
	repository: RepositoryName,
	branch: string,
	commit: string,
	force: boolean,
): Promise<void> {
	await request(`${repositoryPath(repository)}/git/refs/${headRef(branch)}`, token, {
		method: "PATCH",
		body: JSON.stringify({ sha: objectId.parse(commit), force }),
	});
}

export async function openPullRequest(
	token: string,
	repository: RepositoryName,
	input: { title: string; body: string; head: string; base: string },
): Promise<PullRequest> {
	return toPullRequest(
		pullSchema.parse(
			await request(`${repositoryPath(repository)}/pulls`, token, {
				method: "POST",
				body: JSON.stringify(input),
			}),
		),
	);
}

/** The pull request, or null when there is none by that number. */
export async function pullRequest(
	token: string,
	repository: RepositoryName,
	number: number,
): Promise<PullRequest | null> {
	try {
		return toPullRequest(
			pullSchema.parse(await request(`${repositoryPath(repository)}/pulls/${number}`, token)),
		);
	} catch (error) {
		if (error instanceof GitHubError && error.status === 404) return null;
		throw error;
	}
}

/** The open pull request from `branch` of the repository itself, or null when it has none. */
export async function openPullRequestFrom(
	token: string,
	repository: RepositoryName,
	branch: string,
): Promise<PullRequest | null> {
	const query = new URLSearchParams({
		head: `${repository.owner}:${branch}`,
		state: "open",
		per_page: "1",
	});
	const [found] = z
		.array(pullSchema)
		.parse(await request(`${repositoryPath(repository)}/pulls?${query}`, token));
	return found ? toPullRequest(found) : null;
}

export async function updatePullRequest(
	token: string,
	repository: RepositoryName,
	number: number,
	input: { title: string; body: string },
): Promise<PullRequest> {
	return toPullRequest(
		pullSchema.parse(
			await request(`${repositoryPath(repository)}/pulls/${number}`, token, {
				method: "PATCH",
				body: JSON.stringify(input),
			}),
		),
	);
}
