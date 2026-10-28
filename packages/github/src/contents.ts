// Reading a repository at one commit, with an installation token: the branch's head, every file
// in its tree, and the text of the files asked for. Texts come through GraphQL, many blobs per
// request, so a scan stays within a Worker's subrequest limit.
import { z } from "zod";
import { GitHubError, request } from "./app";

export interface RepositoryName {
	owner: string;
	name: string;
}

export interface BranchHead {
	commit: string;
	tree: string;
}

/** A file in a tree. A symlink's blob holds the path it points to. */
export interface TreeEntry {
	path: string;
	blob: string;
	size: number;
	symlink: boolean;
}

/** Blobs per GraphQL request. GitHub caps a query's cost, not its aliases; 50 stays well inside. */
export const TEXTS_PER_REQUEST = 50;

const objectId = z.string().regex(/^[0-9a-f]{40}$/);

const branchSchema = z.object({
	commit: z.object({
		sha: objectId,
		commit: z.object({ tree: z.object({ sha: objectId }) }),
	}),
});

const treeSchema = z.object({
	truncated: z.boolean(),
	tree: z.array(
		z.object({
			path: z.string(),
			mode: z.string(),
			type: z.string(),
			sha: objectId,
			size: z.number().int().nonnegative().optional(),
		}),
	),
});

const blobSchema = z
	.object({
		text: z.string().nullable(),
		isBinary: z.boolean().nullable(),
		isTruncated: z.boolean(),
	})
	.nullable();

const textsSchema = z.object({
	data: z
		.object({ repository: z.record(z.string(), blobSchema).nullable() })
		.nullable()
		.optional(),
	errors: z.array(z.object({ message: z.string() })).optional(),
});

function repositoryPath({ owner, name }: RepositoryName) {
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** The commit a branch points to, and that commit's tree. */
export async function branchHead(
	token: string,
	repository: RepositoryName,
	branch: string,
): Promise<BranchHead> {
	// Branch names may hold slashes, which stay as they are in the path.
	const ref = branch.split("/").map(encodeURIComponent).join("/");
	const { commit } = branchSchema.parse(
		await request(`${repositoryPath(repository)}/branches/${ref}`, token),
	);
	return { commit: commit.sha, tree: commit.commit.tree.sha };
}

/**
 * Every file in a tree, at any depth. Submodules are left out. GitHub stops at 100,000 entries
 * or 7 MB and says so with `truncated`.
 */
export async function readTree(
	token: string,
	repository: RepositoryName,
	tree: string,
): Promise<{ files: TreeEntry[]; truncated: boolean }> {
	const found = treeSchema.parse(
		await request(
			`${repositoryPath(repository)}/git/trees/${objectId.parse(tree)}?recursive=1`,
			token,
		),
	);
	const files: TreeEntry[] = [];
	for (const entry of found.tree) {
		if (entry.type !== "blob") continue;
		files.push({
			path: entry.path,
			blob: entry.sha,
			size: entry.size ?? 0,
			symlink: entry.mode === "120000",
		});
	}
	return { files, truncated: found.truncated };
}

/**
 * The text of each blob, by id. Binary blobs, blobs GitHub truncates and blobs it cannot find
 * map to null.
 */
export async function readTexts(
	token: string,
	repository: RepositoryName,
	blobs: readonly string[],
): Promise<Map<string, string | null>> {
	const ids = [...new Set(blobs.map((blob) => objectId.parse(blob)))];
	const texts = new Map<string, string | null>();
	for (let start = 0; start < ids.length; start += TEXTS_PER_REQUEST) {
		const batch = ids.slice(start, start + TEXTS_PER_REQUEST);
		// The ids are checked hex, so they can sit in the query as they are.
		const fields = batch
			.map(
				(id, index) =>
					`b${index}: object(oid: "${id}") { ... on Blob { text isBinary isTruncated } }`,
			)
			.join("\n");
		const query = `query($owner: String!, $name: String!) {\n repository(owner: $owner, name: $name) {\n${fields}\n }\n}`;
		const response = textsSchema.parse(
			await request("/graphql", token, {
				method: "POST",
				body: JSON.stringify({
					query,
					variables: { owner: repository.owner, name: repository.name },
				}),
			}),
		);
		const found = response.data?.repository;
		if (!found) {
			const message = response.errors?.[0]?.message ?? "no repository in the answer";
			throw new GitHubError(404, `GitHub could not read the files: ${message}`);
		}
		for (const [index, id] of batch.entries()) {
			const blob = found[`b${index}`];
			texts.set(id, blob && !blob.isBinary && !blob.isTruncated ? blob.text : null);
		}
	}
	return texts;
}
