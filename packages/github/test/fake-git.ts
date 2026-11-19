/**
 * Stands in for api.github.com in tests: one repository's branches, trees, blobs, commits and
 * pull requests, kept in memory. A fake that takes anything proves nothing, so it refuses: a
 * wrong token, a token that may only read, anything in the Git database while the repository
 * is empty (409), a tree on a base it does not know, a path that climbs out or names `.git`, an
 * entry with both content and an id, deleting a path that is not there, a commit on an unknown
 * parent, a branch whose name Git would not take, a branch that exists, a move that is not a
 * fast-forward.
 *
 * It is not GitHub, and where nobody has tried GitHub its answer here is a guess: what GitHub
 * says to a workflow file from a token without the Workflows permission; what it does with a
 * path under a file or a file where a folder is, as when one change adds both `a` and `a/b`
 * (this fake says no, and `commitChanges` never asks); and which of the names `repositoryPathProblem` refuses GitHub would take
 * (this fake takes them all but `.git`).
 *
 * It began as the stand-in of the spike for runs without a container (AGT-122) and uses nothing
 * but `fetch`'s own types and `crypto.subtle`, so a suite in workerd can use it as one in Node
 * does: `vi.stubGlobal("fetch", fake.fetch)`.
 *
 * Blob ids are Git's own. Tree and commit ids are made up from their content, so equal trees
 * have equal ids, as Git's do.
 *
 * Where GitHub's documentation does not say what it answers, this says so beside the answer.
 */
import { gitBlobId } from "../src";

interface Entry {
	mode: string;
	type: "blob" | "commit";
	sha: string;
}
type Tree = Map<string, Entry>;
interface Commit {
	tree: string;
	parents: string[];
	message: string;
	author?: { name: string; email: string };
}
interface Pull {
	number: number;
	title: string;
	body: string;
	head: string;
	base: string;
}

const MODES = new Set(["100644", "100755", "120000", "040000", "160000"]);
const WORKFLOWS = ".github/workflows/";

async function idOf(kind: string, value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(`${kind}\0${JSON.stringify(value)}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function refused(status: number, message: string): Response {
	return Response.json({ message }, { status });
}

/** The plainest of `git check-ref-format`'s rules for a branch's name; not all of them. */
function validBranchName(name: string): boolean {
	if (name === "" || name.startsWith("-") || name.startsWith("/")) return false;
	if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
	if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
	for (const char of name) {
		const code = char.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(char)) return false;
	}
	return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Base64 as GitHub sends a blob: lines of sixty characters, each ended by a newline. */
function base64Lines(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/.{1,60}/g, "$&\n");
}

export interface SeedOptions {
	/** Symlinks, by path, with the path each points to. */
	symlinks?: Record<string, string>;
	/** Paths among the files that can be run. */
	executable?: string[];
	/** Submodules, by path, with the commit each pins. */
	submodules?: Record<string, string>;
}

export class FakeGit {
	readonly owner = "acme";
	readonly name = "site";
	readonly repository = { owner: this.owner, name: this.name };
	readonly defaultBranch = "main";
	/** A token that may read and write contents and pull requests. */
	readonly token = "ghs_fake_installation_token";
	/** A token that may only read. */
	readonly readToken = "ghs_fake_read_only_token";
	readonly blobs = new Map<string, Uint8Array>();
	readonly trees = new Map<string, Tree>();
	readonly commits = new Map<string, Commit>();
	readonly branches = new Map<string, string>();
	readonly pulls: Pull[] = [];
	/** Every request it answered, as `METHOD path`. */
	readonly requests: string[] = [];
	/** Blobs GraphQL calls binary, by id. */
	readonly binary = new Set<string>();
	/**
	 * Whether a blob's text comes through GraphQL without its byte order mark. Nobody checked
	 * which GitHub does, so a test can have it either way. REST's blobs are bytes and keep it.
	 */
	dropsMark = false;
	/** A listing longer than this many entries is cut there and marked `truncated`. */
	listingLimit = 100_000;
	/** Whether a blob's answer says how long it is, which a compressed or chunked one does not. */
	sendsLength = true;
	/** Whether the write token holds the Workflows permission. */
	workflows = false;
	/** Called with `METHOD path` before each request is answered: a place to move a branch. */
	before: ((route: string) => void | Promise<void>) | undefined;

	/** `fetch`, bound, for `vi.stubGlobal`. */
	readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
		this.#answer(new Request(input, init));

	/** Makes the default branch's first commit from these files. */
	async seed(
		files: Record<string, string | Uint8Array>,
		options: SeedOptions = {},
	): Promise<string> {
		const tree: Tree = new Map();
		for (const [path, content] of Object.entries(files)) {
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
			const sha = await this.#blob(bytes);
			if (typeof content !== "string") this.binary.add(sha);
			const mode = options.executable?.includes(path) ? "100755" : "100644";
			tree.set(path, { mode, type: "blob", sha });
		}
		for (const [path, target] of Object.entries(options.symlinks ?? {})) {
			const sha = await this.#blob(new TextEncoder().encode(target));
			tree.set(path, { mode: "120000", type: "blob", sha });
		}
		for (const [path, sha] of Object.entries(options.submodules ?? {})) {
			tree.set(path, { mode: "160000", type: "commit", sha });
		}
		const commit = await this.#commit({
			tree: await this.#tree(tree),
			parents: [],
			message: "first",
		});
		this.branches.set(this.defaultBranch, commit);
		return commit;
	}

	/** A commit on top of a branch's tip that someone else pushed, changing one file. */
	async push(branch: string, path: string, content: string): Promise<string> {
		const parent = this.branches.get(branch);
		const tree = new Map(this.trees.get(this.commits.get(parent ?? "")?.tree ?? ""));
		if (!parent) throw new Error(`no branch ${branch}`);
		const sha = await this.#blob(new TextEncoder().encode(content));
		tree.set(path, { mode: "100644", type: "blob", sha });
		const commit = await this.#commit({
			tree: await this.#tree(tree),
			parents: [parent],
			message: `someone else's change to ${path}`,
		});
		this.branches.set(branch, commit);
		return commit;
	}

	/** A branch's files as bytes, by path: what a clone of it would hold. */
	bytesAt(branch: string): Record<string, Uint8Array> {
		const files: Record<string, Uint8Array> = {};
		for (const [path, entry] of this.#treeAt(branch)) {
			if (entry.type === "blob") files[path] = this.blobs.get(entry.sha) ?? new Uint8Array();
		}
		return files;
	}

	/** A branch's files as text, by path, a byte order mark kept. */
	filesAt(branch: string): Record<string, string> {
		const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
		return Object.fromEntries(
			Object.entries(this.bytesAt(branch)).map(([path, bytes]) => [path, decoder.decode(bytes)]),
		);
	}

	/** Every entry's mode on a branch, by path, submodules included. */
	modesAt(branch: string): Record<string, string> {
		return Object.fromEntries([...this.#treeAt(branch)].map(([path, entry]) => [path, entry.mode]));
	}

	commitAt(branch: string): Commit | undefined {
		return this.commits.get(this.branches.get(branch) ?? "");
	}

	#treeAt(branch: string): Tree {
		const tree = this.trees.get(this.commitAt(branch)?.tree ?? "");
		if (!tree) throw new Error(`no branch ${branch}`);
		return tree;
	}

	async #blob(bytes: Uint8Array): Promise<string> {
		const sha = await gitBlobId(bytes);
		this.blobs.set(sha, bytes);
		return sha;
	}

	async #tree(tree: Tree): Promise<string> {
		const id = await idOf(
			"tree",
			[...tree].sort(([a], [b]) => (a < b ? -1 : 1)),
		);
		this.trees.set(id, tree);
		return id;
	}

	async #commit(commit: Commit): Promise<string> {
		const id = await idOf("commit", commit);
		this.commits.set(id, commit);
		return id;
	}

	#descends(commit: string, from: string): boolean {
		const queue = [commit];
		for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
			if (next === from) return true;
			queue.push(...(this.commits.get(next)?.parents ?? []));
		}
		return false;
	}

	/** Whether a commit's tree differs from its first parent's under `.github/workflows`. */
	#touchesWorkflows(sha: string): boolean {
		const commit = this.commits.get(sha);
		const now = this.trees.get(commit?.tree ?? "") ?? new Map<string, Entry>();
		const parent = this.commits.get(commit?.parents[0] ?? "");
		const before = this.trees.get(parent?.tree ?? "") ?? new Map<string, Entry>();
		const paths = new Set([...now.keys(), ...before.keys()]);
		return [...paths].some(
			(path) => path.startsWith(WORKFLOWS) && now.get(path)?.sha !== before.get(path)?.sha,
		);
	}

	async #answer(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.host !== "api.github.com") return refused(502, `not GitHub's API: ${url.host}`);
		const route = `${request.method} ${url.pathname}`;
		await this.before?.(route);
		this.requests.push(route);
		const authorization = request.headers.get("authorization");
		const writes = authorization === `Bearer ${this.token}`;
		if (!writes && authorization !== `Bearer ${this.readToken}`) {
			return refused(401, "Bad credentials");
		}
		if (!request.headers.get("user-agent")) return refused(403, "Request forbidden: no user agent");
		const method = request.method;
		const body = method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);

		if (method === "POST" && url.pathname === "/graphql") return this.#texts(body);

		const prefix = `/repos/${this.owner}/${this.name}/`;
		if (!url.pathname.startsWith(prefix)) return refused(404, "Not Found");
		const resource = url.pathname.slice(prefix.length);
		if (method !== "GET" && !writes) return refused(403, "Resource not accessible by integration");
		// GitHub's guide to the Git database: 409 for a repository that is empty or not ready.
		if (resource.startsWith("git/") && this.branches.size === 0) {
			return refused(409, "Git Repository is empty.");
		}

		const branch = resource.match(/^branches\/(.+)$/);
		if (method === "GET" && branch) {
			const at = this.branches.get(decodeURIComponent(branch[1] ?? ""));
			const commit = this.commits.get(at ?? "");
			if (!at || !commit) return refused(404, "Branch not found");
			return Response.json({ commit: { sha: at, commit: { tree: { sha: commit.tree } } } });
		}

		const listed = resource.match(/^git\/trees\/([0-9a-f]{40})$/);
		if (method === "GET" && listed) return this.#listing(listed[1] ?? "");

		const blob = resource.match(/^git\/blobs\/([0-9a-f]{40})$/);
		if (method === "GET" && blob) {
			const bytes = this.blobs.get(blob[1] ?? "");
			if (!bytes) return refused(404, "Not Found");
			// The raw media type is the blob itself; the default wraps it in JSON as base64.
			const raw = request.headers.get("accept") === "application/vnd.github.raw+json";
			const answer = raw
				? new Uint8Array(bytes)
				: new TextEncoder().encode(
						JSON.stringify({
							sha: blob[1],
							size: bytes.length,
							content: base64Lines(bytes),
							encoding: "base64",
						}),
					);
			return new Response(answer, {
				headers: {
					"content-type": raw ? "application/vnd.github.raw+json" : "application/json",
					...(this.sendsLength ? { "content-length": String(answer.length) } : {}),
				},
			});
		}

		const compared = resource.match(/^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
		if (method === "GET" && compared) {
			const [, base = "", tip = ""] = compared;
			if (!this.commits.has(base) || !this.commits.has(tip)) return refused(404, "Not Found");
			const ahead = this.#descends(tip, base);
			const behind = this.#descends(base, tip);
			return Response.json({
				status: ahead && behind ? "identical" : ahead ? "ahead" : behind ? "behind" : "diverged",
			});
		}

		const read = resource.match(/^git\/commits\/([0-9a-f]{40})$/);
		if (method === "GET" && read) {
			const commit = this.commits.get(read[1] ?? "");
			if (!commit) return refused(404, "Not Found");
			return Response.json({
				sha: read[1],
				message: commit.message,
				tree: { sha: commit.tree },
				parents: commit.parents.map((sha) => ({ sha })),
			});
		}

		if (method === "POST" && resource === "git/trees") return this.#makeTree(body);

		if (method === "POST" && resource === "git/commits") {
			const parents = body.parents as string[];
			if (!this.trees.has(String(body.tree))) return refused(422, "Tree SHA does not exist");
			if (!Array.isArray(parents) || !parents.every((parent) => this.commits.has(parent))) {
				return refused(422, "Parent SHA does not exist or is not a commit object");
			}
			const author = body.author as Commit["author"];
			if (author && (!author.name || !/^[^@\s]+@[^@\s]+$/.test(author.email))) {
				return refused(422, "Invalid author");
			}
			const sha = await this.#commit({
				tree: String(body.tree),
				parents,
				message: String(body.message),
				...(author ? { author } : {}),
			});
			return Response.json({ sha }, { status: 201 });
		}

		if (method === "POST" && resource === "git/refs") {
			const name = String(body.ref);
			if (!name.startsWith("refs/heads/")) return refused(422, "Reference name is not valid");
			const made = name.slice("refs/heads/".length);
			if (!validBranchName(made)) return refused(422, `${name} is not a valid ref name.`);
			if (this.branches.has(made)) return refused(422, "Reference already exists");
			if (!this.commits.has(String(body.sha))) return refused(422, "Object does not exist");
			const barred = this.#workflowsBarred(String(body.sha));
			if (barred) return barred;
			this.branches.set(made, String(body.sha));
			return Response.json({ ref: name, object: { sha: body.sha } }, { status: 201 });
		}

		const ref = resource.match(/^git\/refs?\/heads\/(.+)$/);
		if (ref) {
			const named = (ref[1] ?? "").split("/").map(decodeURIComponent).join("/");
			const at = this.branches.get(named);
			if (method === "GET" && resource.startsWith("git/ref/")) {
				if (at === undefined) return refused(404, "Not Found");
				return Response.json({ ref: `refs/heads/${named}`, object: { sha: at } });
			}
			if (method === "PATCH" && resource.startsWith("git/refs/")) {
				const to = String(body.sha);
				if (at === undefined) return refused(422, "Reference does not exist");
				if (!this.commits.has(to)) return refused(422, "Object does not exist");
				if (body.force !== true && !this.#descends(to, at)) {
					return refused(422, "Update is not a fast forward");
				}
				const barred = this.#workflowsBarred(to);
				if (barred) return barred;
				this.branches.set(named, to);
				return Response.json({ ref: `refs/heads/${named}`, object: { sha: to } });
			}
		}

		if (method === "POST" && resource === "pulls") {
			const head = this.branches.get(String(body.head));
			const base = this.branches.get(String(body.base));
			if (!head || !base) return refused(422, "Validation Failed: head or base is not a branch");
			if (head === base || !this.#descends(head, base)) {
				return refused(422, "No commits between base and head");
			}
			if (this.pulls.some((pull) => pull.head === body.head)) {
				return refused(422, "A pull request already exists for this branch");
			}
			const pull: Pull = {
				number: this.pulls.length + 1,
				title: String(body.title),
				body: String(body.body),
				head: String(body.head),
				base: String(body.base),
			};
			this.pulls.push(pull);
			return Response.json(
				{
					number: pull.number,
					html_url: `https://github.com/${this.owner}/${this.name}/pull/${pull.number}`,
					title: pull.title,
					state: "open",
					merged: false,
					merged_at: null,
					head: { sha: head, ref: pull.head },
					additions: 2,
					deletions: 1,
					changed_files: 1,
				},
				{ status: 201 },
			);
		}
		return refused(404, "Not Found");
	}

	/**
	 * GitHub's documentation says an app needs the Workflows permission to change workflow files
	 * and not which request fails or how. Reports have the objects made and the branch refused,
	 * which is what this does; its status and words are a guess, so nothing should read them.
	 */
	#workflowsBarred(commit: string): Response | null {
		if (this.workflows || !this.#touchesWorkflows(commit)) return null;
		return refused(403, "Resource not accessible by integration");
	}

	/** A recursive listing: folders too, as GitHub lists them, and no size but a blob's. */
	async #listing(id: string): Promise<Response> {
		const tree = this.trees.get(id);
		if (!tree) return refused(404, "Not Found");
		const entries: Record<string, unknown>[] = [];
		const folders = new Set<string>();
		for (const [path, entry] of [...tree].sort(([a], [b]) => (a < b ? -1 : 1))) {
			const parts = path.split("/");
			for (let depth = 1; depth < parts.length; depth++) {
				const folder = parts.slice(0, depth).join("/");
				if (folders.has(folder)) continue;
				folders.add(folder);
				entries.push({
					path: folder,
					mode: "040000",
					type: "tree",
					sha: await idOf("folder", [id, folder]),
				});
			}
			entries.push({
				path,
				mode: entry.mode,
				type: entry.type,
				sha: entry.sha,
				...(entry.type === "blob" ? { size: this.blobs.get(entry.sha)?.length ?? 0 } : {}),
			});
		}
		return Response.json({
			sha: id,
			truncated: entries.length > this.listingLimit,
			tree: entries.slice(0, this.listingLimit),
		});
	}

	async #makeTree(body: Record<string, unknown>): Promise<Response> {
		const base = this.trees.get(String(body.base_tree));
		if (!base) return refused(422, "base_tree is not a valid tree oid");
		const tree: Tree = new Map(base);
		const entries = body.tree as Record<string, unknown>[];
		if (!Array.isArray(entries) || entries.length === 0) return refused(422, "Invalid tree info");
		for (const entry of entries) {
			const path = String(entry.path ?? "");
			const parts = path.split("/");
			if (path === "" || parts.some((part) => part === "" || part === "." || part === "..")) {
				return refused(422, "tree.path contains a malformed path component");
			}
			if (parts.some((part) => part.toLowerCase() === ".git")) {
				return refused(422, "tree.path contains a malformed path component");
			}
			const mode = String(entry.mode);
			if (!MODES.has(mode)) return refused(422, `tree.mode is invalid: ${entry.mode}`);
			if (entry.type !== "blob") return refused(422, "this fake only takes blobs");
			if (mode === "040000" || mode === "160000") {
				return refused(422, "tree.mode does not match tree.type");
			}
			// What Git does with a file where a folder is, or a folder where a file is, is to
			// replace it. This fake keeps paths flat and has no need of that, so it says no.
			const clash = [...tree.keys()].find(
				(other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`),
			);
			if (clash) return refused(422, `this fake does not put ${path} where ${clash} is`);
			const hasId = "sha" in entry;
			const hasContent = "content" in entry;
			if (hasId === hasContent) return refused(422, "tree.sha and tree.content are exclusive");
			if (hasContent) {
				if (typeof entry.content !== "string") return refused(422, "tree.content is not a string");
				const sha = await this.#blob(new TextEncoder().encode(entry.content));
				tree.set(path, { mode, type: "blob", sha });
			} else if (entry.sha === null) {
				if (!tree.delete(path)) return refused(422, "GitRPC::BadObjectState: no such path");
			} else {
				if (!this.blobs.has(String(entry.sha))) return refused(422, "tree.sha is not a blob");
				tree.set(path, { mode, type: "blob", sha: String(entry.sha) });
			}
		}
		return Response.json(
			{ sha: await this.#tree(tree), truncated: false, tree: [] },
			{ status: 201 },
		);
	}

	/** The GraphQL query `readTexts` sends: aliased blobs by id. */
	#texts(body: Record<string, unknown>): Response {
		const variables = body.variables as { owner?: string; name?: string };
		if (variables?.owner !== this.owner || variables?.name !== this.name) {
			return Response.json({ data: { repository: null }, errors: [{ message: "Not Found" }] });
		}
		const repository: Record<string, unknown> = {};
		const aliases = String(body.query).matchAll(/(\w+): object\(oid: "([0-9a-f]{40})"\)/g);
		for (const [, alias, id] of aliases) {
			const bytes = this.blobs.get(id ?? "");
			if (!alias) continue;
			if (!bytes) repository[alias] = null;
			else if (this.binary.has(id ?? "")) {
				repository[alias] = { text: null, isBinary: true, isTruncated: false };
			} else {
				repository[alias] = {
					text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: !this.dropsMark }).decode(
						bytes,
					),
					isBinary: false,
					isTruncated: false,
				};
			}
		}
		return Response.json({ data: { repository } });
	}
}
