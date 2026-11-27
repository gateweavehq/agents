// Writing to a repository with an installation token: a commit on top of a branch's head, a
// branch that points at it, and the pull request that proposes it. Files go into the new tree as
// content, so a commit takes two requests however many files it changes.
import { z } from "zod";
import { GitHubError, request, send } from "./app";
import { gitBlobId, type RepositoryName, TREE_MODES, type TreeItem } from "./contents";
import { encoder } from "./encoding";
import { repositoryPathProblem, WORKFLOWS_FOLDER } from "./paths";

export interface FileChange {
	path: string;
	content: string;
	/** `100755` for a file that can be run. Left out, the file is a plain one, `100644`. */
	mode?: "100644" | "100755";
}

/**
 * Who a commit is by. Left out, GitHub names the token's own account. GitHub signs the commits
 * an app makes through the API as itself; whether it still does when an author is given was
 * not tried, so check it against GitHub before relying on a commit showing as "Verified".
 */
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
	/** The repository's default branch, which is never the branch written to. */
	defaultBranch: string;
	/**
	 * The commit the branch has to be at: the one this caller last put there, or null when the
	 * branch must not exist yet. At anything else, nothing is written.
	 */
	expected: string | null;
	/**
	 * The commit the files were read at, its tree, and what `readTreeEntries` answered for that
	 * tree, `truncated` included. `files` and `deleted` are the whole difference from this tree,
	 * however many commits the branch already holds, so every change to one branch names the
	 * same base: the commit the branch was made from.
	 */
	base: { commit: string; tree: string; entries: readonly TreeItem[]; truncated: boolean };
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
	/** The branch named is the repository's default branch. Nothing was asked of GitHub. */
	| { committed: false; reason: "default-branch" }
	/** GitHub cut the base's listing short, so what must be spared cannot be known. */
	| { committed: false; reason: "truncated" }
	/** The branch does not follow from the base given: it was made from another commit. */
	| { committed: false; reason: "base" }
	/** A path or a file's text that cannot be written this way. Nothing was asked of GitHub. */
	| { committed: false; reason: "path"; path: string; message: string }
	/** GitHub refused: its status (0 when it could not be reached) and what it said. */
	| { committed: false; reason: "refused"; status: number; message: string };

export interface PullRequest {
	number: number;
	url: string;
	title: string;
	state: "open" | "closed" | "merged";
	/** The commit the pull request's branch is at. */
	head: string;
	/** The branch it is from, which a card names. */
	headRef: string;
	/** The branch it is to be merged into, when the answer says (the list endpoint does too). */
	baseRef?: string;
	/** Whether it is a draft. Left out when the answer does not say. */
	draft?: boolean;
	/** Its description, as GitHub has it (empty when there is none). Left out by the list endpoint. */
	body?: string;
	/** GitHub's GraphQL id, which only an answer about the pull request carries. */
	nodeId?: string;
	/**
	 * The change's size. Only an answer about one pull request counts it; the list endpoint
	 * leaves these out, and a card draws without them then.
	 */
	additions?: number;
	deletions?: number;
	changedFiles?: number;
}

const objectId = z.string().regex(/^[0-9a-f]{40}$/);
const shaSchema = z.object({ sha: objectId });
const refSchema = z.object({ object: z.object({ sha: objectId }) });
const commitSchema = z.object({ tree: z.object({ sha: objectId }) });
const compareSchema = z.object({ status: z.enum(["diverged", "ahead", "behind", "identical"]) });
const pullSchema = z.object({
	number: z.number().int().positive(),
	html_url: z.string().url(),
	title: z.string(),
	state: z.enum(["open", "closed"]),
	merged: z.boolean().optional(),
	merged_at: z.string().nullable().optional(),
	head: z.object({ sha: objectId, ref: z.string() }),
	base: z.object({ ref: z.string() }).optional(),
	draft: z.boolean().optional(),
	body: z.string().nullable().optional(),
	node_id: z.string().optional(),
	// Only an answer about one pull request counts changes; the list leaves them out.
	additions: z.number().int().nonnegative().optional(),
	deletions: z.number().int().nonnegative().optional(),
	changed_files: z.number().int().nonnegative().optional(),
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
	// The counts come together or not at all: an endpoint that counts changes gives all three.
	const counted =
		found.additions !== undefined &&
		found.deletions !== undefined &&
		found.changed_files !== undefined
			? {
					additions: found.additions,
					deletions: found.deletions,
					changedFiles: found.changed_files,
				}
			: undefined;
	return {
		number: found.number,
		url: found.html_url,
		title: found.title,
		state: found.state === "open" ? "open" : merged ? "merged" : "closed",
		head: found.head.sha,
		headRef: found.head.ref,
		...(found.base === undefined ? {} : { baseRef: found.base.ref }),
		...(found.draft === undefined ? {} : { draft: found.draft }),
		...(found.body === undefined ? {} : { body: found.body ?? "" }),
		...(found.node_id === undefined ? {} : { nodeId: found.node_id }),
		...counted,
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
 * a new file is a plain one. A symlink or a submodule is never written over or taken out, which
 * holds because a base whose listing GitHub cut short is refused.
 *
 * Refusals come back as values. What is thrown is an answer of GitHub's that makes no sense,
 * or a failure that is not GitHub's own, and the last only once the branch has been read and
 * is not at this call's commit.
 *
 * Requests: four for a new branch (its ref, the tree, the commit, the ref made). Six for one
 * that exists (its ref, the base compared with its tip, the tree, the tip's commit, the commit,
 * the ref moved), and one fewer when no file differs from the base.
 *
 * Limits, each with a test that shows it:
 * - **The branch's move is not a compare-and-swap, and `expected` is not enforced atomically.**
 *   GitHub's REST API moves a ref with no "only if it is still at" and, unforced, checks only
 *   that the move is a fast-forward. So a reset of the branch to an ancestor of `expected`
 *   between this function's look and its move is not detected: the move succeeds and puts back
 *   the commits that were dropped. A commit someone added is never lost; one someone took away
 *   can come back. Nothing in this function can close that; it would take another API.
 * - **The base is checked to be an ancestor of the branch's tip, not to be the very commit the
 *   branch was made from.** A newer base is refused (`base`), since its commit would carry the
 *   default branch's changes as its own. An older one cannot be told from the right one.
 * - **A file is not replaced by a folder, or a folder by a file, in one change**: a path under
 *   a file, or a file where a folder is, is refused, whether the other is in the base or in
 *   the same change, as is a new path beside one that differs only in case. GitHub is never
 *   asked for them, so what it would do does not matter here.
 */
export async function commitChanges(
	token: string,
	repository: RepositoryName,
	input: ChangesInput,
): Promise<ChangesOutcome> {
	if (input.branch === input.defaultBranch) return { committed: false, reason: "default-branch" };
	if (input.base.truncated) return { committed: false, reason: "truncated" };
	const planned = await planChanges(input);
	if ("reason" in planned) return planned;
	const changed = planned.files.length > 0 || planned.deleted.length > 0;
	if (!changed && input.expected === null) return { committed: false, reason: "nothing" };

	let commit: string;
	try {
		const tip = await branchCommit(token, repository, input.branch);
		if (tip !== input.expected) return { committed: false, reason: "branch", found: tip };
		if (input.expected !== null) {
			// The tree below is the base's with the changes, on top of the branch's tip. Were the
			// base not behind the tip, the commit would hold whatever lies between them as its own.
			const base = objectId.parse(input.base.commit);
			const compared = compareSchema.parse(
				await request(
					`${repositoryPath(repository)}/compare/${base}...${objectId.parse(input.expected)}?per_page=1`,
					token,
				),
			);
			if (compared.status !== "ahead" && compared.status !== "identical") {
				return { committed: false, reason: "base" };
			}
		}
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
		// Whatever failed, and of whatever class, what became of the write is not known yet: a
		// connection can break after GitHub moved the branch, even after the answer's headers
		// came. So the branch is read. At this call's own commit, the write was applied and only
		// its answer was lost. Elsewhere than expected, GitHub held part of the same line as the
		// look above: the name is taken, or the move is not a fast-forward. Which it was is read
		// from the branch, not from GitHub's words.
		try {
			const tip = await branchCommit(token, repository, input.branch);
			if (tip === commit) return { committed: true, commit };
			if (tip !== input.expected) return { committed: false, reason: "branch", found: tip };
		} catch {
			// The failure that came first says more than a failed second look.
		}
		if (error instanceof GitHubError) return refusal(error);
		throw error;
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
	// Every name in the tree by its lower case, so a new name that differs from one only in case
	// is caught: on Windows and macOS the two would be one file, or one folder. The tree is taken
	// as this change leaves it: a path it deletes is not there to differ from, nor a folder once
	// every file in it is deleted, so a file can change the case of its name in one change.
	const spellings = new Map<string, string>();
	const gone = new Set(input.deleted);
	const known = new Set<string>();
	for (const path of entries.keys()) {
		if (gone.has(path)) continue;
		for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
			known.add(path.slice(0, end));
		}
	}
	for (const name of known) {
		if (!spellings.has(name.toLowerCase())) spellings.set(name.toLowerCase(), name);
	}
	/** The name a new path, or a folder above it, differs from only in case; it joins the tree. */
	const caseTwin = (path: string): string | null => {
		const names: string[] = [];
		for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
			names.unshift(path.slice(0, end));
		}
		// The topmost folder first, so the answer names where the two part ways.
		for (const name of names) {
			const twin = spellings.get(name.toLowerCase());
			if (twin !== undefined && !known.has(name)) return twin;
		}
		for (const name of names) {
			known.add(name);
			if (!spellings.has(name.toLowerCase())) spellings.set(name.toLowerCase(), name);
		}
		return null;
	};
	// The files this change writes and the folders they need, each with the file that needs it:
	// one change cannot have `new` as a file and `new/page.md` under it.
	const written = new Set<string>();
	const needed = new Map<string, string>();
	/** Why a written path cannot stand beside another this change writes; it joins them. */
	const clash = (path: string): string | null => {
		const within = needed.get(path);
		if (within !== undefined) {
			return `is a folder for ${within}, which this change also writes, and cannot be a file too`;
		}
		const above: string[] = [];
		for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
			above.push(path.slice(0, end));
		}
		for (const folder of above) {
			if (written.has(folder)) {
				return `is under ${folder}, which this change also writes as a file`;
			}
		}
		written.add(path);
		for (const folder of above) if (!needed.has(folder)) needed.set(folder, path);
		return null;
	};
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
		if (!file.content.isWellFormed()) {
			return refuse(file.path, "holds text that is not Unicode: half of a surrogate pair");
		}
		const clashing = clash(file.path);
		if (clashing !== null) return refuse(file.path, clashing);
		const twin = caseTwin(file.path);
		if (twin !== null) return refuse(file.path, `differs only in case from ${twin}`);
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
	input: { title: string; body: string; head: string; base: string; draft?: boolean },
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

/**
 * The diff between two commits, as text, read up to `limit` bytes: what `head` changes since
 * `base`, which for a pull request is the commit where its branch left the one it is based on
 * (`changedFiles` names it). Both are commit ids, so the answer does not move when a branch does.
 * `tooLarge` when it is longer, or when GitHub will not make one that big (it answers 406 or 422);
 * null when GitHub has no such commit.
 */
export async function commitDiff(
	token: string,
	repository: RepositoryName,
	base: string,
	head: string,
	limit: number,
): Promise<{ diff: string } | { tooLarge: true } | null> {
	let response: Response;
	try {
		response = await send(
			`${repositoryPath(repository)}/compare/${objectId.parse(base)}...${objectId.parse(head)}`,
			token,
			{},
			"application/vnd.github.v3.diff",
		);
	} catch (error) {
		if (error instanceof GitHubError) {
			if (error.status === 404) return null;
			if (error.status === 406 || error.status === 422) return { tooLarge: true };
		}
		throw error;
	}
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let read = 0;
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		read += value.length;
		if (read > limit) {
			await reader.cancel();
			return { tooLarge: true };
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(read);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return { diff: new TextDecoder().decode(bytes) };
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

/** A file a branch changes against the default branch, as GitHub's comparison lists it. */
export interface ChangedFile {
	path: string;
	status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
	/** Where a renamed file was. */
	previousPath?: string;
}

const changedFilesSchema = z.object({
	merge_base_commit: z.object({ sha: objectId }),
	files: z
		.array(
			z.object({
				filename: z.string(),
				status: z.enum([
					"added",
					"removed",
					"modified",
					"renamed",
					"copied",
					"changed",
					"unchanged",
				]),
				previous_filename: z.string().optional(),
			}),
		)
		.default([]),
});

/** The most files GitHub's comparison lists; a branch with this many may have more. */
export const COMPARED_FILES_LIMIT = 300;

/**
 * What `branch` changes against `base`, file by file, and the commit where it left `base`. One
 * request is enough: GitHub's pagination pages the comparison's commits, and the changed files
 * come with the first page, up to 300 for the whole comparison. So `complete` is false for a
 * branch that reaches the limit: the list may be missing some.
 */
export async function changedFiles(
	token: string,
	repository: RepositoryName,
	base: string,
	branch: string,
): Promise<{ files: ChangedFile[]; mergeBase: string; complete: boolean }> {
	const range = `${encodeURIComponent(base)}...${encodeURIComponent(branch)}`;
	// per_page counts commits, which are not read, so the smallest page is the cheapest.
	const compared = changedFilesSchema.parse(
		await request(`${repositoryPath(repository)}/compare/${range}?per_page=1&page=1`, token),
	);
	const files: ChangedFile[] = compared.files.map((file) => ({
		path: file.filename,
		status: file.status,
		...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
	}));
	return {
		files,
		mergeBase: compared.merge_base_commit.sha,
		complete: files.length < COMPARED_FILES_LIMIT,
	};
}

/**
 * A file's text at a commit: null only when the file is not there (a 404). A response that
 * says nothing about whether it is there, such as a denied read (403) or a rate limit, throws,
 * so a caller that must tell an absent file from an unreadable one can.
 */
export async function readTextAt(
	token: string,
	repository: RepositoryName,
	path: string,
	commit: string,
): Promise<string | null> {
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	try {
		const response = await send(
			`${repositoryPath(repository)}/contents/${encoded}?ref=${encodeURIComponent(commit)}`,
			token,
			{},
			"application/vnd.github.raw+json",
		);
		return await response.text();
	} catch (error) {
		if (error instanceof GitHubError && error.status === 404) return null;
		throw error;
	}
}

/** A file's text at a commit, or null when it is not there or is too large to be read. */
export async function textAt(
	token: string,
	repository: RepositoryName,
	path: string,
	commit: string,
): Promise<string | null> {
	try {
		return await readTextAt(token, repository, path, commit);
	} catch (error) {
		if (error instanceof GitHubError && error.status === 403) return null;
		throw error;
	}
}

const convertSchema = z.object({
	data: z
		.object({ convertPullRequestToDraft: z.object({}).passthrough() })
		.nullable()
		.optional(),
	errors: z.array(z.object({ message: z.string() })).optional(),
});

/**
 * Makes an open pull request a draft again. Only GraphQL can: the REST API opens a pull request
 * as a draft but cannot convert one. `nodeId` is the pull request's `nodeId`.
 */
export async function convertPullRequestToDraft(token: string, nodeId: string): Promise<void> {
	const answer = convertSchema.parse(
		await request("/graphql", token, {
			method: "POST",
			body: JSON.stringify({
				query:
					"mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }",
				variables: { id: nodeId },
			}),
		}),
	);
	// GraphQL answers 200 with errors, so a pull request that was not converted is read here.
	if (!answer.data?.convertPullRequestToDraft) {
		throw new GitHubError(
			422,
			`GitHub could not make the pull request a draft: ${answer.errors?.[0]?.message ?? "no answer"}`,
		);
	}
}
