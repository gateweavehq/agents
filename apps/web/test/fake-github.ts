import {
	createHash,
	createHmac,
	createVerify,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";

export interface FakeRepository {
	id: number;
	name: string;
	owner: string;
	defaultBranch?: string;
	private?: boolean;
	/** The default branch's files: text, or `{ symlink }` for a symlink to that path. */
	files?: Record<string, string | { symlink: string }>;
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
