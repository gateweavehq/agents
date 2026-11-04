/**
 * The little of GitLab's REST API (v4) a scan needs, for gitlab.com or a self-managed GitLab: who
 * a token acts as, the projects it reaches, a branch's head, a commit's tree and raw blobs. An
 * access token goes in `PRIVATE-TOKEN`, which takes personal, project and group tokens alike.
 *
 * GitLab's tree gives Git's blob ids, so files and assets get the same ids and hashes as on
 * GitHub. It does not give sizes; they are 0 here, and a blob too large to keep is found when it
 * is read.
 */
import { MAX_FILE_LENGTH } from "@gateweave/agents-model";
import { z } from "zod";
import type { SourceFile } from "../scanner";

export interface GitLabAccess {
	/** Such as `https://gitlab.com`, without a trailing slash. */
	baseUrl: string;
	token: string;
	/** Stands in for the global `fetch` in tests. */
	fetch?: typeof fetch;
}

/** A project as the registry keeps it. */
export interface GitLabProject {
	id: string;
	namespace: string;
	path: string;
	defaultBranch: string;
	private: boolean;
}

/** Most projects one connection brings in. */
export const MAX_GITLAB_PROJECTS = 1000;
/** Most tree entries a scan lists: GitLab pages them by 100. */
export const MAX_GITLAB_TREE_ENTRIES = 20_000;
const READS_AT_ONCE = 6;

export class GitLabError extends Error {}

const user = z.object({ username: z.string(), name: z.string().nullish() });

const project = z.object({
	id: z.number(),
	path: z.string(),
	path_with_namespace: z.string(),
	namespace: z.object({ full_path: z.string() }),
	// An empty repository has no default branch, and nothing to scan.
	default_branch: z.string().nullish(),
	visibility: z.string().nullish(),
	archived: z.boolean().nullish(),
});

const branch = z.object({ commit: z.object({ id: z.string() }) });

const treeEntry = z.object({
	id: z.string(),
	type: z.string(),
	path: z.string(),
	mode: z.string(),
});

/** Who the token acts as: a person, or a project's or group's bot. */
export async function gitlabUser(access: GitLabAccess): Promise<string> {
	const found = user.parse(await json(access, "/user"));
	return found.username;
}

/**
 * The projects the token's user is a member of with at least Reporter access, which can read the
 * repository. Archived and empty projects are left out.
 */
export async function gitlabProjects(
	access: GitLabAccess,
): Promise<{ projects: GitLabProject[]; truncated: boolean }> {
	const projects: GitLabProject[] = [];
	let page: string | null = "1";
	while (page && projects.length < MAX_GITLAB_PROJECTS) {
		const response = await request(
			access,
			`/projects?membership=true&min_access_level=20&archived=false&order_by=id&sort=asc&per_page=100&page=${page}`,
		);
		for (const found of z.array(project).parse(await response.json())) {
			if (!found.default_branch || found.archived) continue;
			projects.push({
				id: String(found.id),
				namespace: found.namespace.full_path,
				path: found.path,
				defaultBranch: found.default_branch,
				private: found.visibility !== "public",
			});
		}
		page = response.headers.get("x-next-page") || null;
	}
	return {
		projects: projects.slice(0, MAX_GITLAB_PROJECTS),
		truncated: projects.length >= MAX_GITLAB_PROJECTS && page !== null,
	};
}

/** The commit a branch points to. GitLab names trees by commit, so that stands for the tree too. */
export async function gitlabBranchHead(
	access: GitLabAccess,
	projectId: string,
	branchName: string,
): Promise<{ commit: string; tree: string }> {
	const found = branch.parse(
		await json(
			access,
			`/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(branchName)}`,
		),
	);
	return { commit: found.commit.id, tree: found.commit.id };
}

/** Every file at a commit: blobs and symlinks, without submodules. */
export async function gitlabTree(
	access: GitLabAccess,
	projectId: string,
	commit: string,
): Promise<{ files: SourceFile[]; truncated: boolean }> {
	const files: SourceFile[] = [];
	let entries = 0;
	let next: string | null =
		`/projects/${encodeURIComponent(projectId)}/repository/tree?ref=${encodeURIComponent(commit)}&recursive=true&per_page=100&pagination=keyset`;
	while (next && entries < MAX_GITLAB_TREE_ENTRIES) {
		const response = await request(access, next);
		const page = z.array(treeEntry).parse(await response.json());
		entries += page.length;
		for (const entry of page) {
			if (entry.type !== "blob") continue;
			files.push({ path: entry.path, blob: entry.id, size: 0, symlink: entry.mode === "120000" });
		}
		next = nextLink(access, response.headers.get("link"));
	}
	return { files, truncated: next !== null };
}

/**
 * Texts by blob id; null for a blob that is binary, not UTF-8, or longer than the registry keeps.
 * A few are read at a time.
 */
export async function gitlabTexts(
	access: GitLabAccess,
	projectId: string,
	blobIds: readonly string[],
): Promise<Map<string, string | null>> {
	const texts = new Map<string, string | null>();
	const ids = [...new Set(blobIds)];
	for (let start = 0; start < ids.length; start += READS_AT_ONCE) {
		const batch = ids.slice(start, start + READS_AT_ONCE);
		const read = await Promise.all(batch.map((id) => readBlob(access, projectId, id)));
		for (const [index, id] of batch.entries()) texts.set(id, read[index] ?? null);
	}
	return texts;
}

async function readBlob(
	access: GitLabAccess,
	projectId: string,
	blobId: string,
): Promise<string | null> {
	if (!/^[0-9a-f]{40,64}$/.test(blobId)) throw new GitLabError("GitLab named a blob strangely");
	const response = await request(
		access,
		`/projects/${encodeURIComponent(projectId)}/repository/blobs/${blobId}/raw`,
	);
	const declared = Number(response.headers.get("content-length") ?? "0");
	// UTF-8 takes at least one byte for each character the registry keeps.
	if (declared > MAX_FILE_LENGTH * 4) {
		await response.body?.cancel();
		return null;
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.includes(0)) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
	return text.length > MAX_FILE_LENGTH ? null : text;
}

async function json(access: GitLabAccess, path: string): Promise<unknown> {
	return (await request(access, path)).json();
}

/** A request to the API, with GitLab's refusals in words a person can act on. */
async function request(access: GitLabAccess, path: string): Promise<Response> {
	let response: Response;
	try {
		response = await (access.fetch ?? fetch)(`${access.baseUrl}/api/v4${path}`, {
			headers: { "PRIVATE-TOKEN": access.token, Accept: "application/json" },
			// A redirect would send the token somewhere else.
			redirect: "manual",
		});
	} catch {
		throw new GitLabError(`${access.baseUrl} could not be reached`);
	}
	if (response.ok) return response;
	await response.body?.cancel();
	if (response.status === 401) throw new GitLabError("GitLab did not accept the token");
	if (response.status === 403) {
		throw new GitLabError("The token cannot read this; it needs read_api and read_repository");
	}
	if (response.status === 404) throw new GitLabError("GitLab has nothing at that address");
	if (response.status === 429) {
		throw new GitLabError("GitLab's limit on requests was reached; try again later");
	}
	if (response.status >= 300 && response.status < 400) {
		throw new GitLabError(`${access.baseUrl} redirects elsewhere; enter the GitLab's own address`);
	}
	throw new GitLabError(`GitLab answered with an error (${response.status})`);
}

/** The next page of a keyset listing, from GitLab's `Link` header, on the same GitLab only. */
function nextLink(access: GitLabAccess, header: string | null): string | null {
	const match = header ? /<([^>]+)>;\s*rel="next"/.exec(header) : null;
	if (!match?.[1]) return null;
	const prefix = `${access.baseUrl}/api/v4`;
	return match[1].startsWith(`${prefix}/`) ? match[1].slice(prefix.length) : null;
}
