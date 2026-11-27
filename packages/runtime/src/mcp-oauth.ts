/**
 * The OAuth client side of an MCP server connected for a workspace, for `@ai-sdk/mcp`:
 * its `auth()` runs the flow (discovery, dynamic client registration, PKCE, the token exchange)
 * and its transports send and refresh the token, and both keep what they need through this
 * provider, in the registry, sealed (`packages/registry/src/mcp-oauth.ts`). The app uses it to
 * connect a server, and the runtime to reach one in a turn or a check.
 */
import {
	auth,
	type OAuthClientInformation,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthTokens,
} from "@ai-sdk/mcp";
import { z } from "zod";

const safeUrl = z
	.string()
	.url()
	.refine((value) => {
		if (!URL.canParse(value)) return false;
		return !["javascript:", "data:", "vbscript:"].includes(new URL(value).protocol);
	});

const refreshResponse = z.object({
	access_token: z.string(),
	token_type: z.string(),
	refresh_token: z.string().optional(),
	id_token: z.string().optional(),
	expires_in: z.number().optional(),
	scope: z.string().optional(),
	issuer: safeUrl.optional(),
	authorization_server: safeUrl.optional(),
	token_endpoint: safeUrl.optional(),
});

/** What the registry keeps for a server, as `mcpOAuthOpen` and `mcpOAuthSave` take and give it. */
export interface OAuthStore {
	mcpOAuthOpen(assetId: string): Promise<{
		serverUrl: string;
		client: unknown;
		verifier: string | null;
		tokens: unknown;
	} | null>;
	mcpRefreshClaim?(assetId: string): Promise<{ kind: "claimed"; lease: string } | { kind: "busy" }>;
	mcpRefreshRelease?(assetId: string, lease: string): Promise<void>;
	mcpHealthInvalidate?(assetId: string): Promise<void>;
	mcpOAuthSave(
		assetId: string,
		parts: {
			client?: unknown;
			verifier?: string | null;
			tokens?: unknown;
			expectedTokens?: unknown;
			expectedClient?: unknown;
			expectedVerifier?: string | null;
			unlessSigningIn?: boolean;
		},
	): Promise<boolean>;
}

/** Why a turn cannot use a connection any more: someone has to sign in again. */
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_WAIT_MS = 20_000;

export class OAuthRefreshWaitError extends Error {
	constructor() {
		super("The sign-in server is busy; it will be checked again");
	}
}

export const SIGN_IN_AGAIN =
	"Its OAuth connection no longer works. An owner or admin can connect it again on the MCP page";

export class OAuthSignInNeeded extends Error {
	constructor() {
		super(SIGN_IN_AGAIN);
	}
}

export interface ProviderOptions {
	/**
	 * The app's callback, which the server sends the person back to. A turn, which never signs
	 * in, leaves it out and uses the one the client was registered with.
	 */
	redirectUrl?: string;
	/** The state the registry made for this flow; only for connecting. */
	state?: string;
	/** Where to send the person to sign in; only for connecting. A turn has nobody to send. */
	onRedirect?: (url: URL) => void;
	/**
	 * Start from a sign-in, not from the tokens kept: someone connecting again signs in as
	 * themselves rather than refreshing the earlier person's tokens.
	 */
	freshSignIn?: boolean;
	healthCheck?: boolean;
	/** The URL whose credentials this provider may open. */
	serverUrl?: string;
}

export class RegistryOAuthProvider implements OAuthClientProvider {
	readonly #store: OAuthStore;
	readonly #assetId: string;
	readonly #options: ProviderOptions;
	#loaded: Awaited<ReturnType<OAuthStore["mcpOAuthOpen"]>> | undefined;
	#refreshLease: string | undefined;
	#refreshSource: unknown | undefined;
	#adoptedRefresh = false;
	#clientRejected = false;
	#healthCheck = false;
	#serverUrl: string | undefined;

	bindServerUrl(serverUrl: string): void {
		this.#serverUrl = serverUrl;
	}

	get clientRejected(): boolean {
		return this.#clientRejected;
	}

	async invalidateHealth(): Promise<void> {
		await this.#store.mcpHealthInvalidate?.(this.#assetId);
	}

	markHealthCheck(): void {
		this.#healthCheck = true;
	}

	constructor(store: OAuthStore, assetId: string, options: ProviderOptions) {
		this.#store = store;
		this.#assetId = assetId;
		this.#options = options;
	}

	get redirectUrl(): string {
		const registered = (this.#loaded?.client as { redirect_uris?: string[] } | undefined)
			?.redirect_uris?.[0];
		return this.#options.redirectUrl ?? registered ?? "";
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Gateweave Agents",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// A public client with PKCE: there is no client secret to keep.
			token_endpoint_auth_method: "none",
		} as OAuthClientMetadata;
	}

	async #data() {
		this.#loaded ??= await this.#store.mcpOAuthOpen(this.#assetId);
		this.#assertServer(this.#loaded);
		return this.#loaded;
	}

	#assertServer(data: Awaited<ReturnType<OAuthStore["mcpOAuthOpen"]>>) {
		const target = this.#serverUrl ?? this.#options.serverUrl;
		if (data && target && data.serverUrl !== target) throw new OAuthSignInNeeded();
	}

	async #save(parts: {
		client?: unknown;
		verifier?: string | null;
		tokens?: unknown;
		expectedTokens?: unknown;
		expectedClient?: unknown;
		expectedVerifier?: string | null;
		unlessSigningIn?: boolean;
	}) {
		const saved = await this.#store.mcpOAuthSave(this.#assetId, parts);
		if (!saved) {
			this.#loaded = await this.#store.mcpOAuthOpen(this.#assetId);
			return;
		}
		const data = await this.#data();
		if (data) this.#loaded = { ...data, ...parts } as typeof data;
	}

	async clientInformation(): Promise<OAuthClientInformation | undefined> {
		return ((await this.#data())?.client ?? undefined) as OAuthClientInformation | undefined;
	}

	isClientInformationDynamicallyRegistered(): boolean {
		return true;
	}

	async saveClientInformation(client: OAuthClientInformation): Promise<void> {
		await this.#save({ client, ...(!this.#options.onRedirect ? { unlessSigningIn: true } : {}) });
	}

	async storedTokens(): Promise<unknown> {
		const data = await this.#store.mcpOAuthOpen(this.#assetId);
		this.#assertServer(data);
		return data?.tokens ?? null;
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		if (this.#options.freshSignIn) return undefined;
		return ((await this.#data())?.tokens ?? undefined) as OAuthTokens | undefined;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		try {
			if (this.#adoptedRefresh) return;
			await this.#save({
				tokens,
				...(this.#options.freshSignIn
					? {}
					: { expectedTokens: this.#refreshSource ?? this.#loaded?.tokens }),
			});
		} finally {
			this.#adoptedRefresh = false;
			this.#refreshSource = undefined;
			await this.releaseRefresh();
		}
	}

	async releaseRefresh(): Promise<void> {
		const lease = this.#refreshLease;
		this.#refreshLease = undefined;
		if (lease) await this.#store.mcpRefreshRelease?.(this.#assetId, lease);
	}

	/** Serializes rotating refresh tokens across checks and turns for this connection. */
	fetchWithRefreshLease(fetchFn: typeof fetch, callerSignal?: AbortSignal): typeof fetch {
		return async (input, init) => {
			const waitSignal = callerSignal
				? init?.signal
					? AbortSignal.any([callerSignal, init.signal])
					: callerSignal
				: init?.signal;
			const body = init?.body;
			const form =
				typeof body === "string"
					? new URLSearchParams(body)
					: body instanceof URLSearchParams
						? body
						: null;
			if (form?.get("grant_type") !== "refresh_token" || !this.#store.mcpRefreshClaim)
				return fetchFn(input, init);
			const expected = form.get("refresh_token");
			const loadedAccess = (await this.#data())?.tokens as OAuthTokens | null | undefined;
			const deadline = Date.now() + REFRESH_WAIT_MS;
			let delay = 100;
			for (;;) {
				if (waitSignal?.aborted) throw waitSignal.reason;
				if (Date.now() >= deadline) throw new OAuthRefreshWaitError();
				const claim = await this.#store.mcpRefreshClaim(this.#assetId);
				if (claim.kind === "busy") {
					await new Promise<void>((resolve, reject) => {
						const wait = Math.min(delay, Math.max(0, deadline - Date.now()));
						const timer = setTimeout(() => {
							waitSignal?.removeEventListener("abort", abort);
							resolve();
						}, wait);
						const abort = () => {
							clearTimeout(timer);
							reject(waitSignal?.reason);
						};
						waitSignal?.addEventListener("abort", abort, { once: true });
						if (waitSignal?.aborted) abort();
					});
					delay = Math.min(delay * 2, 1000);
					continue;
				}
				this.#refreshLease = claim.lease;
				try {
					if (waitSignal?.aborted) throw waitSignal.reason;
					const fresh = await this.#store.mcpOAuthOpen(this.#assetId);
					this.#assertServer(fresh);
					const tokens = fresh?.tokens as OAuthTokens | null | undefined;
					this.#loaded = fresh;
					if (!tokens) throw new OAuthSignInNeeded();
					if (tokens?.access_token && tokens.access_token !== loadedAccess?.access_token) {
						this.#adoptedRefresh = true;
						await this.releaseRefresh();
						return Response.json(tokens);
					}
					if (tokens?.refresh_token && tokens.refresh_token !== expected) {
						this.#adoptedRefresh = true;
						await this.releaseRefresh();
						return Response.json(tokens);
					}
					this.#refreshSource = loadedAccess;
					if (waitSignal?.aborted) throw waitSignal.reason;
					const response = await fetchFn(input, {
						...init,
						signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
					});
					if (!response.ok) {
						this.#refreshSource = undefined;
						await this.releaseRefresh();
					}
					if (response.ok) {
						const parsed = await response
							.clone()
							.json()
							.catch(() => null);
						if (!refreshResponse.safeParse(parsed).success) {
							this.#refreshSource = undefined;
							await this.releaseRefresh();
						}
					}
					return response;
				} catch (error) {
					this.#refreshSource = undefined;
					await this.releaseRefresh();
					throw error;
				}
			}
		};
	}

	async saveCodeVerifier(verifier: string): Promise<void> {
		if (!this.#options.onRedirect) throw new OAuthSignInNeeded();
		await this.#save({ verifier });
	}

	async codeVerifier(): Promise<string> {
		const verifier = (await this.#data())?.verifier;
		if (!verifier) throw new Error("No sign-in is under way for this server");
		return verifier;
	}

	state(): string {
		// A turn never sends anyone to sign in, so its state goes nowhere.
		return this.#options.state ?? crypto.randomUUID();
	}

	redirectToAuthorization(url: URL): void {
		if (!this.#options.onRedirect) throw new OAuthSignInNeeded();
		this.#options.onRedirect(url);
	}

	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier",
		context?: { tokens: OAuthTokens },
	): Promise<void> {
		const sent = await this.#data();
		if (scope === "all") {
			this.#clientRejected = true;
			if (this.#options.healthCheck || this.#healthCheck) return;
			await this.#save({
				client: null,
				tokens: null,
				expectedClient: sent?.client ?? null,
				expectedTokens: sent?.tokens ?? null,
				unlessSigningIn: true,
			});
		} else if (scope === "client")
			await this.#save({
				client: null,
				expectedClient: sent?.client ?? null,
				expectedTokens: sent?.tokens ?? null,
				unlessSigningIn: true,
			});
		else if (scope === "tokens")
			await this.#save({
				tokens: null,
				expectedClient: sent?.client ?? null,
				expectedTokens: context?.tokens ?? sent?.tokens ?? null,
			});
		else if (this.#options.onRedirect)
			await this.#save({
				verifier: null,
				expectedClient: sent?.client ?? null,
				expectedTokens: sent?.tokens ?? null,
				expectedVerifier: sent?.verifier ?? null,
			});
	}
}

/**
 * Starts connecting a server: discovers its authorization server, registers the app as a client
 * if it has not yet, and returns where to send the person to sign in. Null when the server
 * granted tokens without a sign-in, which a standard server does not.
 */
export async function startOAuth(
	store: OAuthStore,
	assetId: string,
	flow: { serverUrl: string; redirectUrl: string; state: string },
): Promise<URL | null> {
	let destination: URL | null = null;
	const provider = new RegistryOAuthProvider(store, assetId, {
		redirectUrl: flow.redirectUrl,
		state: flow.state,
		freshSignIn: true,
		serverUrl: flow.serverUrl,
		onRedirect: (url) => {
			destination = url;
		},
	});
	await auth(provider, { serverUrl: flow.serverUrl, fetchFn: fetchWithoutRedirects });
	return destination;
}

/** Finishes connecting a server: trades the code the server sent back for tokens, and keeps them. */
export async function finishOAuth(
	store: OAuthStore,
	assetId: string,
	flow: { serverUrl: string; redirectUrl: string; code: string; state: string; issuer?: string },
): Promise<void> {
	const provider = new RegistryOAuthProvider(store, assetId, {
		redirectUrl: flow.redirectUrl,
		state: flow.state,
		freshSignIn: true,
		serverUrl: flow.serverUrl,
	});
	const before = await store.mcpOAuthOpen(assetId);
	let result: Awaited<ReturnType<typeof auth>>;
	try {
		result = await auth(provider, {
			serverUrl: flow.serverUrl,
			fetchFn: fetchWithoutRedirects,
			authorizationCode: flow.code,
			callbackState: flow.state,
			...(flow.issuer ? { callbackIssuer: flow.issuer } : {}),
		});
	} catch (error) {
		const code = (error as { constructor?: { errorCode?: string } }).constructor?.errorCode;
		await store.mcpOAuthSave(assetId, {
			verifier: null,
			expectedVerifier: before?.verifier ?? null,
			...(code === "invalid_client" || code === "unauthorized_client"
				? { client: null, expectedClient: before?.client ?? null }
				: {}),
		});
		throw error;
	}
	if (result !== "AUTHORIZED") throw new Error("The server did not grant access");
	// The verifier was for this sign-in alone.
	await store.mcpOAuthSave(assetId, { verifier: null });
}

/**
 * The OAuth client asks fetch to refuse redirects with `redirect: "error"`, which Workers do not
 * take. `manual` does the same here: a 3xx answer is a failure, and nothing follows it.
 */
const fetchWithoutRedirects: typeof fetch = (input, init) =>
	fetch(input, { ...init, redirect: "manual" });
