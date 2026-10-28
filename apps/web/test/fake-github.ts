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

		switch (route) {
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
