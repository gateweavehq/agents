import {
	createHash,
	createHmac,
	createVerify,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";

/** A file's text, or `{ symlink }` for a symlink to that path. */
export type FakeFile = string | { symlink: string };

export interface FakeRepository {
	id: number;
	name: string;
	owner: string;
	defaultBranch?: string;
	private?: boolean;
	/** The default branch's files. */
	files?: Record<string, FakeFile>;
}

export interface FakePull {
	number: number;
	title: string;
	body: string;
	head: string;
	base: string;
	state: "open" | "closed";
	merged: boolean;
}

/** `git hash-object` of this text. */
export function gitBlobId(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	return createHash("sha1")
		.update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
		.digest("hex");
}

function fakeCommit(repository: FakeRepository, kind: "commit" | "tree"): string {
	return createHash("sha1")
		.update(`${kind}\0${JSON.stringify(Object.entries(repository.files ?? {}).sort())}`)
		.digest("hex");
}

/** The id a fake repository's default branch is at: it changes whenever its files do. */
export function headOf(repository: FakeRepository): string {
	return fakeCommit(repository, "commit");
}

function keyOf(repository: FakeRepository): string {
	return `${repository.owner}/${repository.name}`;
}

function blobsOf(repository: FakeRepository) {
	return Object.entries(repository.files ?? {}).map(([path, file]) => {
		const text = typeof file === "string" ? file : file.symlink;
		return { path, text, symlink: typeof file !== "string", sha: gitBlobId(text) };
	});
}

interface FakeInstallation {
	account: { login: string; type: "User" | "Organization" };
	repositories: FakeRepository[];
}

/**
 * Stands in for github.com and api.github.com behind the Worker's outbound requests. It checks
 * what GitHub checks: the app's JWT against its public key, installation tokens, the OAuth
 * client, PKCE and which installations each person can reach.
 */
export class FakeGitHub {
	readonly appId = "4242";
	readonly slug = "gateweave-agents-test";
	readonly clientId = "Iv1.testclient";
	readonly clientSecret = randomBytes(16).toString("hex");
	readonly webhookSecret = randomBytes(16).toString("hex");
	readonly installations = new Map<string, FakeInstallation>();
	/** The installations each GitHub login can reach. */
	readonly people = new Map<string, Set<string>>();

	readonly #keys = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	readonly #codes = new Map<string, { login: string; challenge: string; redirectUri: string }>();
	readonly #tokens = new Map<string, string>();
	/** Every blob id a GraphQL request asked for, in order. */
	readonly blobRequests: string[] = [];
	/** Repositories whose reads fail, by `owner/name`, with the status GitHub answers. */
	readonly failing = new Map<string, number>();
	/** Installations whose app may only read, as one without write permissions. */
	readonly readOnly = new Set<string>();
	/** Branches other than the default one, by `owner/name`, then name: the commit each is at. */
	readonly branches = new Map<string, Map<string, string>>();
	/** Pull requests, by `owner/name`, numbered from 1. */
	readonly pulls = new Map<string, FakePull[]>();
	/** Trees and commits made through the API, by id: every file each holds. */
	readonly #trees = new Map<string, Record<string, FakeFile>>();
	readonly #commits = new Map<string, { files: Record<string, FakeFile>; parents: string[] }>();
	#objects = 0;

	/** The Worker's settings for this app. */
	bindings(): Record<string, string> {
		return {
			GITHUB_APP_ID: this.appId,
			GITHUB_APP_SLUG: this.slug,
			GITHUB_APP_CLIENT_ID: this.clientId,
			GITHUB_APP_CLIENT_SECRET: this.clientSecret,
			GITHUB_APP_PRIVATE_KEY: this.#keys.privateKey,
			GITHUB_APP_WEBHOOK_SECRET: this.webhookSecret,
		};
	}

	/** `login` approves the app at the authorize URL; returns where GitHub sends them back. */
	authorize(authorizeUrl: string, login: string): string {
		const url = new URL(authorizeUrl);
		if (url.origin + url.pathname !== "https://github.com/login/oauth/authorize") {
			throw new Error(`Not an authorize URL: ${authorizeUrl}`);
		}
		if (url.searchParams.get("client_id") !== this.clientId) throw new Error("Wrong client");
		if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("No PKCE");
		const redirectUri = url.searchParams.get("redirect_uri") ?? "";
		const code = randomBytes(8).toString("hex");
		this.#codes.set(code, {
			login,
			challenge: url.searchParams.get("code_challenge") ?? "",
			redirectUri,
		});
		const callback = new URL(redirectUri);
		callback.searchParams.set("code", code);
		callback.searchParams.set("state", url.searchParams.get("state") ?? "");
		return callback.href;
	}

	/** The signature header GitHub would send with this body. */
	sign(body: string): string {
		return `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
	}

	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = `${request.method} ${url.host}${url.pathname}`;
		const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

		const installationPath = url.pathname.match(/^\/app\/installations\/(\d+)(\/access_tokens)?$/);
		if (url.host === "api.github.com" && installationPath) {
			if (!this.#validJwt(bearer)) return Response.json({ message: "Bad JWT" }, { status: 401 });
			const [, id = "", tokens] = installationPath;
			const installation = this.installations.get(id);
			if (!installation) return Response.json({ message: "Not Found" }, { status: 404 });
			if (!tokens) return Response.json({ id: Number(id), account: installation.account });
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const token = `ghs_${randomBytes(12).toString("hex")}`;
			this.#tokens.set(token, id);
			const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			return Response.json({ token, expires_at: expiresAt }, { status: 201 });
		}

		const contents = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(branches|git\/trees)\/(.+)$/);
		if (url.host === "api.github.com" && request.method === "GET" && contents) {
			const [, owner = "", name = "", kind, rest = ""] = contents;
			const repository = this.#reachable(bearer, owner, name);
			if (!repository) return Response.json({ message: "Not Found" }, { status: 404 });
			const failing = this.failing.get(`${owner}/${name}`);
			if (failing) return Response.json({ message: "Something broke" }, { status: failing });
			if (kind === "branches") {
				if (decodeURIComponent(rest) !== (repository.defaultBranch ?? "main")) {
					return Response.json({ message: "Branch not found" }, { status: 404 });
				}
				const tree = fakeCommit(repository, "tree");
				return Response.json({
					commit: { sha: headOf(repository), commit: { tree: { sha: tree } } },
				});
			}
			if (rest !== fakeCommit(repository, "tree") || url.searchParams.get("recursive") !== "1") {
				return Response.json({ message: "Not Found" }, { status: 404 });
			}
			return Response.json({
				sha: rest,
				truncated: false,
				tree: blobsOf(repository).map((blob) => ({
					path: blob.path,
					mode: blob.symlink ? "120000" : "100644",
					type: "blob",
					sha: blob.sha,
					size: Buffer.byteLength(blob.text),
				})),
			});
		}

		const write = url.pathname.match(
			/^\/repos\/([^/]+)\/([^/]+)\/(git\/trees|git\/commits|git\/refs?(?:\/.*)?|pulls(?:\/\d+)?)$/,
		);
		if (url.host === "api.github.com" && write) {
			const [, owner = "", name = "", resource = ""] = write;
			const repository = this.#reachable(bearer, owner, name);
			if (!repository) return Response.json({ message: "Not Found" }, { status: 404 });
			if (request.method !== "GET" && this.readOnly.has(this.#tokens.get(bearer) ?? "")) {
				return Response.json(
					{ message: "Resource not accessible by integration" },
					{ status: 403 },
				);
			}
			return this.#write(repository, request.method, resource, request);
		}

		switch (route) {
			case "POST api.github.com/graphql": {
				const { query, variables } = (await request.json()) as {
					query: string;
					variables: { owner: string; name: string };
				};
				const repository = this.#reachable(bearer, variables.owner, variables.name);
				if (!repository) {
					return Response.json({
						data: { repository: null },
						errors: [{ message: "Could not resolve" }],
					});
				}
				const blobs = new Map(blobsOf(repository).map((blob) => [blob.sha, blob.text]));
				const answer: Record<string, unknown> = {};
				for (const [, alias = "", oid = ""] of query.matchAll(
					/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g,
				)) {
					this.blobRequests.push(oid);
					const text = blobs.get(oid);
					answer[alias] = text === undefined ? null : { text, isBinary: false, isTruncated: false };
				}
				return Response.json({ data: { repository: answer } });
			}
			case "GET api.github.com/installation/repositories": {
				const installation = this.installations.get(this.#tokens.get(bearer) ?? "");
				if (!installation) return Response.json({ message: "Bad credentials" }, { status: 401 });
				return Response.json({
					total_count: installation.repositories.length,
					repositories: installation.repositories.map((repository) => ({
						id: repository.id,
						name: repository.name,
						owner: { login: repository.owner },
						default_branch: repository.defaultBranch ?? "main",
						private: repository.private ?? true,
					})),
				});
			}
			case "POST github.com/login/oauth/access_token": {
				const body = (await request.json()) as Record<string, string>;
				const grant = this.#codes.get(body.code ?? "");
				this.#codes.delete(body.code ?? "");
				const verifier = createHash("sha256")
					.update(body.code_verifier ?? "")
					.digest("base64url");
				if (
					body.client_id !== this.clientId ||
					body.client_secret !== this.clientSecret ||
					!grant ||
					grant.challenge !== verifier ||
					grant.redirectUri !== body.redirect_uri
				) {
					return Response.json({ error: "bad_verification_code" });
				}
				return Response.json({ access_token: `ghu_${grant.login}`, token_type: "bearer" });
			}
			case "GET api.github.com/user/installations": {
				const reachable = this.people.get(bearer.replace(/^ghu_/, ""));
				if (!bearer.startsWith("ghu_") || !reachable) {
					return Response.json({ message: "Bad credentials" }, { status: 401 });
				}
				return Response.json({
					total_count: reachable.size,
					installations: [...reachable].map((id) => ({ id: Number(id) })),
				});
			}
			default:
				return Response.json({ message: `No fake for ${route}` }, { status: 404 });
		}
	}

	/** Every file on a branch of the repository, or undefined when there is no such branch. */
	filesAt(repository: FakeRepository, branch: string): Record<string, FakeFile> | undefined {
		if (branch === (repository.defaultBranch ?? "main")) return repository.files ?? {};
		const commit = this.branches.get(keyOf(repository))?.get(branch);
		return commit === undefined ? undefined : this.#commits.get(commit)?.files;
	}

	pullsOf(repository: FakeRepository): FakePull[] {
		return this.pulls.get(keyOf(repository)) ?? [];
	}

	/** Merges a pull request: the default branch takes its branch's files. No webhook is sent. */
	merge(repository: FakeRepository, number: number): void {
		const pull = this.pullsOf(repository).find((candidate) => candidate.number === number);
		if (!pull) throw new Error(`No pull request #${number}`);
		repository.files = { ...this.filesAt(repository, pull.head) };
		pull.state = "closed";
		pull.merged = true;
	}

	/** Closes a pull request without merging it. No webhook is sent. */
	close(repository: FakeRepository, number: number): void {
		const pull = this.pullsOf(repository).find((candidate) => candidate.number === number);
		if (!pull) throw new Error(`No pull request #${number}`);
		pull.state = "closed";
	}

	/** Someone else pushes a commit to a branch, changing no file. */
	pushTo(repository: FakeRepository, branch: string): void {
		const branches = this.branches.get(keyOf(repository));
		const at = branches?.get(branch);
		if (!branches || at === undefined) throw new Error(`No branch ${branch}`);
		branches.set(branch, this.#commit({ ...this.#commits.get(at)?.files }, [at]));
	}

	async #write(
		repository: FakeRepository,
		method: string,
		resource: string,
		request: Request,
	): Promise<Response> {
		const body = method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
		const refused = (message: string) => Response.json({ message }, { status: 422 });
		const defaultBranch = repository.defaultBranch ?? "main";
		const branches = this.branches.get(keyOf(repository)) ?? new Map<string, string>();
		this.branches.set(keyOf(repository), branches);
		const pulls = this.pullsOf(repository);
		this.pulls.set(keyOf(repository), pulls);
		const pullJson = (pull: FakePull) => ({
			number: pull.number,
			html_url: `https://github.com/${keyOf(repository)}/pull/${pull.number}`,
			state: pull.state,
			merged: pull.merged,
			merged_at: pull.merged ? new Date().toISOString() : null,
			head: { ref: pull.head, sha: branches.get(pull.head) ?? "0".repeat(40) },
		});

		if (method === "POST" && resource === "git/trees") {
			const base =
				body.base_tree === fakeCommit(repository, "tree")
					? (repository.files ?? {})
					: this.#trees.get(String(body.base_tree));
			if (!base) return refused("base_tree is not a tree");
			const files = { ...base };
			for (const entry of body.tree as { path: string; mode: string; content: string }[]) {
				if (entry.mode !== "100644") return refused(`Unexpected mode ${entry.mode}`);
				files[entry.path] = entry.content;
			}
			const sha = this.#objectId("tree");
			this.#trees.set(sha, files);
			return Response.json({ sha, truncated: false, tree: [] }, { status: 201 });
		}
		if (method === "POST" && resource === "git/commits") {
			const files = this.#trees.get(String(body.tree));
			const parents = body.parents as string[];
			const known = (sha: string) => sha === headOf(repository) || this.#commits.has(sha);
			if (!files || parents.length === 0 || !parents.every(known)) {
				return refused("Unknown tree or parent");
			}
			return Response.json({ sha: this.#commit(files, parents) }, { status: 201 });
		}
		if (method === "POST" && resource === "git/refs") {
			const branch = String(body.ref).replace(/^refs\/heads\//, "");
			if (branches.has(branch) || branch === defaultBranch) {
				return refused("Reference already exists");
			}
			if (!this.#commits.has(String(body.sha))) return refused("Object does not exist");
			branches.set(branch, String(body.sha));
			return Response.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 });
		}
		const ref = resource.match(/^git\/refs?\/heads\/(.+)$/);
		if (ref) {
			const branch = ref[1]?.split("/").map(decodeURIComponent).join("/") ?? "";
			const at = branches.get(branch);
			if (method === "GET" && resource.startsWith("git/ref/")) {
				return at === undefined
					? Response.json({ message: "Not Found" }, { status: 404 })
					: Response.json({ ref: `refs/heads/${branch}`, object: { sha: at } });
			}
			if (method === "PATCH" && resource.startsWith("git/refs/")) {
				const commit = this.#commits.get(String(body.sha));
				if (at === undefined || !commit) return refused("Reference does not exist");
				if (body.force !== true && !commit.parents.includes(at)) {
					return refused("Update is not a fast forward");
				}
				branches.set(branch, String(body.sha));
				return Response.json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
			}
		}
		if (method === "POST" && resource === "pulls") {
			if (!branches.has(String(body.head)) || body.base !== defaultBranch) {
				return refused("Invalid head or base");
			}
			const pull: FakePull = {
				number: pulls.length + 1,
				title: String(body.title),
				body: String(body.body),
				head: String(body.head),
				base: String(body.base),
				state: "open",
				merged: false,
			};
			pulls.push(pull);
			return Response.json(pullJson(pull), { status: 201 });
		}
		const number = resource.match(/^pulls\/(\d+)$/)?.[1];
		const pull = pulls.find((candidate) => String(candidate.number) === number);
		if (pull && method === "GET") return Response.json(pullJson(pull));
		if (pull && method === "PATCH") {
			if (typeof body.title === "string") pull.title = body.title;
			if (typeof body.body === "string") pull.body = body.body;
			return Response.json(pullJson(pull));
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	}

	#commit(files: Record<string, FakeFile>, parents: string[]): string {
		const sha = this.#objectId("commit");
		this.#commits.set(sha, { files, parents });
		return sha;
	}

	#objectId(kind: string): string {
		this.#objects += 1;
		return createHash("sha1").update(`${kind}\0${this.#objects}`).digest("hex");
	}

	/** The repository, if the installation behind this token reaches it. */
	#reachable(token: string, owner: string, name: string): FakeRepository | undefined {
		const installation = this.installations.get(this.#tokens.get(token) ?? "");
		return installation?.repositories.find(
			(repository) => repository.owner === owner && repository.name === name,
		);
	}

	#validJwt(token: string): boolean {
		const [header, payload, signature] = token.split(".");
		if (!header || !payload || !signature) return false;
		const verify = createVerify("RSA-SHA256").update(`${header}.${payload}`);
		if (!verify.verify(this.#keys.publicKey, Buffer.from(signature, "base64url"))) return false;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
			iss: string;
			exp: number;
		};
		return claims.iss === this.appId && claims.exp * 1000 > Date.now();
	}
}
