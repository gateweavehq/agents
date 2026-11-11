import {
	Client,
	type OAuthClientInformationMixed,
	type OAuthClientProvider,
	type OAuthTokens,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { startAgents } from "./agents-worker";

// An AI agent connecting to Agents' own /mcp, as the person it acts as: discovery, dynamic client
// registration, consent and the PKCE code exchange, against the built Worker.

type Agents = Awaited<ReturnType<typeof startAgents>>;

// Never called: the tests read the code from where consent sends the browser.
export const redirectUrl = "http://127.0.0.1:47199/callback";

/** An MCP client's OAuth state, kept in memory. */
export class MemoryProvider implements OAuthClientProvider {
	client: OAuthClientInformationMixed | undefined;
	savedTokens: OAuthTokens | undefined;
	verifier = "";
	authorizationUrl: URL | undefined;

	get redirectUrl() {
		return redirectUrl;
	}
	get clientMetadata() {
		return {
			client_name: "Agents integration test",
			redirect_uris: [redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}
	clientInformation() {
		return this.client;
	}
	saveClientInformation(client: OAuthClientInformationMixed) {
		this.client = client;
	}
	tokens() {
		return this.savedTokens;
	}
	saveTokens(tokens: OAuthTokens) {
		this.savedTokens = tokens;
	}
	saveCodeVerifier(verifier: string) {
		this.verifier = verifier;
	}
	codeVerifier() {
		return this.verifier;
	}
	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url;
	}
}

/** Calls Better Auth as a browser on Agents' own pages would. */
export async function authApi(
	agents: Agents,
	origin: string,
	path: string,
	cookie: string,
	body: object,
) {
	const response = await agents.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, cookie },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response;
}

/** Connects an agent to /mcp for the person whose session `cookie` is, who allows it. */
export async function connectAgent(
	agents: Agents,
	origin: string,
	cookie: string,
): Promise<Client> {
	const provider = new MemoryProvider();
	const transport = () =>
		new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
			authProvider: provider,
			fetch: agents.fetch,
		});
	const client = new Client({ name: "agents-test", version: "1.0.0" });
	await client.connect(transport()).then(
		() => {
			throw new Error("/mcp answered without a token");
		},
		(error: unknown) => {
			if (!(error instanceof UnauthorizedError)) throw error;
		},
	);
	const authorize = provider.authorizationUrl;
	if (!authorize) throw new Error("The agent was never sent to authorize");
	// Requests from tests arrive as fetches, so Better Auth answers with where to go next.
	const toConsent = await agents.fetch(authorize, { headers: { cookie } });
	const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
	const decision = await authApi(agents, origin, "/oauth2/consent", cookie, {
		accept: true,
		oauth_query: consent.search.slice(1),
	});
	const callback = new URL(((await decision.json()) as { url: string }).url);
	await transport().finishAuth(callback.searchParams);
	await client.connect(transport());
	return client;
}
