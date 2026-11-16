// Reading a repository at one commit, with an installation token: the branch's head, every file
// in its tree, and the text of the files asked for. Texts come through GraphQL, many blobs per
// request, so a scan stays within a Worker's subrequest limit.
import { z } from "zod";
import { GitHubError, request, send } from "./app";

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

/** What a tree's entry is, as Git writes it. */
export const TREE_MODES = {
	file: "100644",
	executable: "100755",
	symlink: "120000",
	submodule: "160000",
} as const;

/** An entry of a tree with its mode: a file, an executable file, a symlink or a submodule. */
export interface TreeItem {
	path: string;
	/** One of `TREE_MODES`, or whatever else an old repository holds. */
	mode: string;
	/** The blob's id. A symlink's blob holds its target; a submodule's id is the commit it pins. */
	id: string;
	/** The blob's size in bytes; 0 for a submodule. */
	size: number;
}

/** A blob's bytes, or that it is larger than the caller will take. */
export type BlobRead =
	| { read: true; bytes: Uint8Array<ArrayBuffer>; size: number }
	| { read: false; size: number | null };

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
	const found = await listTree(token, repository, tree);
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
 * Every entry of a tree that is not a folder, at any depth, with its mode: what a commit made
 * through the API has to know, so an executable file keeps its bit and a symlink or a submodule
 * is not written over. `truncated` says GitHub cut the listing, as for `readTree`. The answer is
 * what `commitChanges` takes as its base, and it refuses a truncated one, since what it cannot
 * see it cannot spare.
 */
export async function readTreeEntries(
	token: string,
	repository: RepositoryName,
	tree: string,
): Promise<{ entries: TreeItem[]; truncated: boolean }> {
	const found = await listTree(token, repository, tree);
	const entries: TreeItem[] = [];
	for (const entry of found.tree) {
		if (entry.type !== "blob" && entry.type !== "commit") continue;
		entries.push({ path: entry.path, mode: entry.mode, id: entry.sha, size: entry.size ?? 0 });
	}
	return { entries, truncated: found.truncated };
}

async function listTree(token: string, repository: RepositoryName, tree: string) {
	return treeSchema.parse(
		await request(
			`${repositoryPath(repository)}/git/trees/${objectId.parse(tree)}?recursive=1`,
			token,
		),
	);
}

/** `git hash-object` of these bytes: the id Git and GitHub give the blob that holds them. */
export async function gitBlobId(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
	const whole = new Uint8Array(header.length + bytes.length);
	whole.set(header, 0);
	whole.set(bytes, header.length);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", whole));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** GitHub's media type for a blob as it is, with no JSON and no base64 around it. */
const RAW = "application/vnd.github.raw+json";

/**
 * One blob's exact bytes, by its id: a byte order mark, line ends and bytes that are not text
 * come back as they are, which GraphQL's `text` does not promise. They are asked for raw, so
 * nothing is decoded and the bytes are in memory at most twice, as they arrive and as one array.
 * A blob over `maxBytes` is not returned: by the answer's length where GitHub gives one, and
 * otherwise by reading no further than `maxBytes`, so a file of 100 MB does not pass through
 * memory to be refused. `size` is null when the answer was cut off before its length was known.
 */
export async function readBlob(
	token: string,
	repository: RepositoryName,
	blob: string,
	maxBytes: number,
): Promise<BlobRead> {
	const id = objectId.parse(blob);
	const response = await send(`${repositoryPath(repository)}/git/blobs/${id}`, token, {}, RAW);
	// A compressed answer's length is the compressed one, which says nothing of the blob's.
	const length = response.headers.has("content-encoding")
		? Number.NaN
		: Number(response.headers.get("content-length") ?? Number.NaN);
	if (length > maxBytes) {
		await response.body?.cancel().catch(() => {});
		return { read: false, size: length };
	}
	const bytes = await bytesUpTo(response, maxBytes);
	if (bytes === null) return { read: false, size: null };
	if ((await gitBlobId(bytes)) !== id) {
		throw new GitHubError(502, "GitHub answered with bytes that are not the blob asked for");
	}
	return { read: true, bytes, size: bytes.length };
}

/** The body's bytes, or null, with the rest unread, once there are more than `limit`. */
async function bytesUpTo(
	response: Response,
	limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	if (response.body) {
		const reader = response.body.getReader();
		for (;;) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (error) {
				throw new GitHubError(0, `GitHub's answer broke off: ${String(error)}`);
			}
			if (chunk.done) break;
			length += chunk.value.length;
			if (length > limit) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(chunk.value);
		}
	}
	const bytes = new Uint8Array(length);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
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
