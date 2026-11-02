/**
 * The OAuth client side of an MCP server connected for a workspace (AGT-78), for `@ai-sdk/mcp`:
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

/** What the registry keeps for a server, as `mcpOAuthOpen` and `mcpOAuthSave` take and give it. */
export interface OAuthStore {
	mcpOAuthOpen(assetId: string): Promise<{
		serverUrl: string;
		client: unknown;
		verifier: string | null;
		tokens: unknown;
	} | null>;
	mcpOAuthSave(
		assetId: string,
		parts: { client?: unknown; verifier?: string | null; tokens?: unknown },
	): Promise<boolean>;
}

/** Why a turn cannot use a connection any more: someone has to sign in again. */
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
}

export class RegistryOAuthProvider implements OAuthClientProvider {
	readonly #store: OAuthStore;
	readonly #assetId: string;
	readonly #options: ProviderOptions;
	#loaded: Awaited<ReturnType<OAuthStore["mcpOAuthOpen"]>> | undefined;

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
		return this.#loaded;
	}

	async #save(parts: { client?: unknown; verifier?: string | null; tokens?: unknown }) {
		await this.#store.mcpOAuthSave(this.#assetId, parts);
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
		await this.#save({ client });
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		if (this.#options.freshSignIn) return undefined;
		return ((await this.#data())?.tokens ?? undefined) as OAuthTokens | undefined;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.#save({ tokens });
	}

	async saveCodeVerifier(verifier: string): Promise<void> {
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

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
		if (scope === "all") await this.#save({ client: null, tokens: null, verifier: null });
		else if (scope === "client") await this.#save({ client: null });
		else if (scope === "tokens") await this.#save({ tokens: null });
		else await this.#save({ verifier: null });
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
	});
	const result = await auth(provider, {
		serverUrl: flow.serverUrl,
		fetchFn: fetchWithoutRedirects,
		authorizationCode: flow.code,
		callbackState: flow.state,
		...(flow.issuer ? { callbackIssuer: flow.issuer } : {}),
	});
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
