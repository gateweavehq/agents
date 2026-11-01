import type { RepositoryInput } from "@gateweave/agents-model";
import { z } from "zod";
import { appJwt, importAppKey } from "./jwt";

export const API_URL = "https://api.github.com";

/** A request to GitHub that failed. `status` is the HTTP status, 0 when none came back. */
export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

export interface GitHubAppConfig {
	appId: string;
	/** The PEM GitHub gave out, PKCS#1 or PKCS#8. */
	privateKey: string;
}

export interface Installation {
	id: string;
	account: { login: string; type: string };
}

const installationSchema = z.object({
	id: z.number().int(),
	account: z.object({ login: z.string(), type: z.string() }),
});

const repositorySchema = z.object({
	id: z.number().int(),
	name: z.string(),
	owner: z.object({ login: z.string() }),
	default_branch: z.string(),
	private: z.boolean(),
});

const tokenSchema = z.object({ token: z.string(), expires_at: z.string() });

const appSchema = z.object({ slug: z.string() });

const botSchema = z.object({ id: z.number().int(), login: z.string() });

/** The account a GitHub App's commits are by: GitHub links a commit with this address to it. */
export interface BotIdentity {
	login: string;
	email: string;
}

/** Installation tokens last an hour; one is reused until a few minutes before it runs out. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/**
 * Talks to GitHub as one GitHub App: as the app itself (a JWT) or as one of its installations
 * (an installation token). One instance per isolate caches the key and the tokens.
 */
export class GitHubApp {
	readonly #appId: string;
	readonly #key: Promise<CryptoKey>;
	readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
	readonly #bots = new Map<string, Promise<BotIdentity>>();

	constructor(config: GitHubAppConfig) {
		this.#appId = config.appId;
		this.#key = importAppKey(config.privateKey);
	}

	/** The installation's account. Throws a 404 `GitHubError` if it does not exist. */
	async installation(installationId: string): Promise<Installation> {
		const jwt = await appJwt(this.#appId, await this.#key);
		const found = installationSchema.parse(
			await request(`/app/installations/${encodeURIComponent(installationId)}`, jwt),
		);
		return { id: String(found.id), account: found.account };
	}

	/** Every repository the installation reaches, as the registry takes them. */
	async repositories(installationId: string): Promise<RepositoryInput[]> {
		const token = await this.installationToken(installationId);
		const page = z.object({ total_count: z.number(), repositories: z.array(repositorySchema) });
		const found: RepositoryInput[] = [];
		for (let number = 1; ; number++) {
			const { total_count, repositories } = page.parse(
				await request(`/installation/repositories?per_page=100&page=${number}`, token),
			);
			for (const repository of repositories) {
				found.push({
					provider: "github",
					externalId: String(repository.id),
					installationId,
					owner: repository.owner.login,
					name: repository.name,
					defaultBranch: repository.default_branch,
					private: repository.private,
				});
			}
			if (repositories.length < 100 || found.length >= total_count) return found;
		}
	}

	/**
	 * The bot account of the app, which commits made for it are by. Asked of GitHub once per
	 * installation and kept; a failed lookup is not kept, so the next call asks again.
	 */
	botIdentity(installationId: string): Promise<BotIdentity> {
		let pending = this.#bots.get(installationId);
		if (!pending) {
			pending = this.#lookupBot(installationId);
			this.#bots.set(installationId, pending);
			pending.catch(() => {
				if (this.#bots.get(installationId) === pending) this.#bots.delete(installationId);
			});
		}
		return pending;
	}

	async #lookupBot(installationId: string): Promise<BotIdentity> {
		const jwt = await appJwt(this.#appId, await this.#key);
		const app = appSchema.parse(await request("/app", jwt));
		const token = await this.installationToken(installationId);
		const bot = botSchema.parse(
			await request(`/users/${encodeURIComponent(`${app.slug}[bot]`)}`, token),
		);
		return { login: bot.login, email: `${bot.id}+${app.slug}[bot]@users.noreply.github.com` };
	}

	async installationToken(installationId: string): Promise<string> {
		return this.#token(installationId, installationId, undefined);
	}

	/**
	 * A token of the installation that reaches only one repository, by GitHub's id for it, and
	 * only with `permissions`: what a sandbox's requests to GitHub go out with.
	 */
	async repositoryToken(
		installationId: string,
		repositoryId: string,
		permissions: Partial<Record<RepositoryPermission, "read" | "write">>,
	): Promise<string> {
		const granted = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b));
		const cacheKey = `${installationId}:${repositoryId}:${JSON.stringify(granted)}`;
		return this.#token(installationId, cacheKey, {
			repository_ids: [Number(repositoryId)],
			permissions: Object.fromEntries(granted),
		});
	}

	async #token(installationId: string, cacheKey: string, scope: object | undefined) {
		const cached = this.#tokens.get(cacheKey);
		if (cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.token;
		const jwt = await appJwt(this.#appId, await this.#key);
		const { token, expires_at } = tokenSchema.parse(
			await request(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, jwt, {
				method: "POST",
				...(scope === undefined ? {} : { body: JSON.stringify(scope) }),
			}),
		);
		this.#tokens.set(cacheKey, { token, expiresAt: Date.parse(expires_at) });
		return token;
	}
}

/** What a repository-scoped token may be granted; the app must hold each permission itself. */
export type RepositoryPermission = "contents" | "pull_requests";

// One client per isolate and app, so the key is imported once and tokens are reused.
let shared: { appId: string; privateKey: string; app: GitHubApp } | undefined;

/** The isolate's client for the app, made on first use and again only when the settings change. */
export function sharedApp(config: GitHubAppConfig): GitHubApp {
	if (shared?.appId !== config.appId || shared.privateKey !== config.privateKey) {
		shared = { ...config, app: new GitHubApp(config) };
	}
	return shared.app;
}

/**
 * Whether the user behind a user access token controls the installation's account: it is their
 * own user account, or they are an active admin of its organization. `/user/installations`
 * alone is not proof, because it lists an installation for anyone with read access to one of its
 * repositories, and linking an installation lets a workspace scan and open pull requests on all
 * of them. Anything GitHub will not confirm, such as an app without the "Members: read"
 * permission, counts as no.
 */
export async function userControlsInstallation(
	userToken: string,
	installationId: string,
): Promise<boolean> {
	const page = z.object({
		total_count: z.number(),
		installations: z.array(
			z.object({
				id: z.number().int(),
				account: z.object({ login: z.string(), type: z.string() }).nullish(),
			}),
		),
	});
	let seen = 0;
	for (let number = 1; ; number++) {
		const { total_count, installations } = page.parse(
			await request(`/user/installations?per_page=100&page=${number}`, userToken),
		);
		const found = installations.find(({ id }) => String(id) === installationId);
		if (found) return controlsAccount(userToken, found.account);
		seen += installations.length;
		if (installations.length < 100 || seen >= total_count) return false;
	}
}

async function controlsAccount(
	userToken: string,
	account: { login: string; type: string } | null | undefined,
): Promise<boolean> {
	if (!account) return false;
	if (account.type === "User") {
		const me = z.object({ login: z.string() }).parse(await request("/user", userToken));
		return me.login.toLowerCase() === account.login.toLowerCase();
	}
	if (account.type !== "Organization") return false;
	try {
		const membership = z
			.object({ state: z.string(), role: z.string() })
			.parse(
				await request(`/user/memberships/orgs/${encodeURIComponent(account.login)}`, userToken),
			);
		return membership.state === "active" && membership.role === "admin";
	} catch (error) {
		// Not a member, or no permission to see: neither is control. Other failures are GitHub's.
		if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
			return false;
		}
		throw error;
	}
}

/** A REST call to the GitHub API. */
export async function request(path: string, token: string, init: RequestInit = {}) {
	let response: Response;
	try {
		response = await fetch(`${API_URL}${path}`, {
			...init,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"user-agent": "gateweave-agents",
				"x-github-api-version": "2022-11-28",
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
			},
		});
	} catch (error) {
		throw new GitHubError(0, `GitHub could not be reached: ${String(error)}`);
	}
	if (!response.ok) {
		const body = await response.text();
		throw new GitHubError(
			response.status,
			`GitHub answered ${response.status}: ${body.slice(0, 200)}`,
		);
	}
	return response.json();
}
