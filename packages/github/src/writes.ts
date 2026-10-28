// Writing to a repository with an installation token: a commit on top of a branch's head, a
// branch that points at it, and the pull request that proposes it. Files go into the new tree as
// content, so a commit takes two requests however many files it changes.
import { z } from "zod";
import { GitHubError, request } from "./app";
import type { RepositoryName } from "./contents";

export interface FileChange {
	path: string;
	content: string;
}

export interface CommitInput {
	/** The commit the new one follows, and its tree, which keeps every file not changed. */
	parent: string;
	tree: string;
	files: readonly FileChange[];
	message: string;
}

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
	const tree = shaSchema.parse(
		await request(`${repositoryPath(repository)}/git/trees`, token, {
			method: "POST",
			body: JSON.stringify({
				base_tree: objectId.parse(input.tree),
				tree: input.files.map((file) => ({
					path: file.path,
					mode: "100644",
					type: "blob",
					content: file.content,
				})),
			}),
		}),
	);
	const commit = shaSchema.parse(
		await request(`${repositoryPath(repository)}/git/commits`, token, {
			method: "POST",
			body: JSON.stringify({
				message: input.message,
				tree: tree.sha,
				parents: [objectId.parse(input.parent)],
			}),
		}),
	);
	return commit.sha;
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
