import {
	Client,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { authApi as authApiIn, MemoryProvider, redirectUrl } from "./mcp-client";

// An AI agent connecting to Agents' own /mcp from scratch, against the built Worker in workerd:
// discovery, dynamic client registration, sign-in, consent, the PKCE code exchange and a tool
// call. (`mcp-oauth.test.ts` is the other direction: Agents' agents reaching library servers.)

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

function authApi(path: string, cookie: string, body: object) {
	return authApiIn(agents, origin, path, cookie, body);
}

const listTools = {
	method: "POST",
	headers: {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	},
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
};

describe("MCP over OAuth, in the Workers runtime", () => {
	it("connects an agent from scratch and lets it see only its person's workspaces", async () => {
		const maya = await signUp(agents, origin, "maya");
		await createWorkspace(agents, origin, maya.headers, "acme");
		const sam = await signUp(agents, origin, "sam");
		await createWorkspace(agents, origin, sam.headers, "someone-elses");
		const cookie = maya.headers.cookie;

		const provider = new MemoryProvider();
		const transport = () =>
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
				authProvider: provider,
				fetch: agents.fetch,
			});

		// Without a token, the agent is sent to authorize, after registering itself.
		const client = new Client({ name: "agents-test", version: "1.0.0" });
		await expect(client.connect(transport())).rejects.toBeInstanceOf(UnauthorizedError);
		expect(provider.client?.client_id).toBeTruthy();
		const authorize = provider.authorizationUrl;
		if (!authorize) throw new Error("The agent was never sent to authorize");
		expect(authorize.searchParams.get("resource")).toBe(`${origin}/mcp`);

		// Signed in, the person lands on the consent page and allows the agent. Requests from this
		// test arrive as fetches, so Better Auth answers with where to go next instead of redirecting.
		const toConsent = await agents.fetch(authorize, { headers: { cookie } });
		const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
		expect(consent.pathname).toBe("/oauth/consent");
		const decision = await authApi("/oauth2/consent", cookie, {
			accept: true,
			oauth_query: consent.search.slice(1),
		});
		const callback = new URL(((await decision.json()) as { url: string }).url);
		expect(`${callback.origin}${callback.pathname}`).toBe(redirectUrl);

		// The agent redeems the code with its PKCE verifier and calls the tool with the token.
		await transport().finishAuth(callback.searchParams);
		expect(provider.savedTokens?.scope).toContain("agents");
		await client.connect(transport());
		const workspaces = await client.callTool({ name: "list_workspaces", arguments: {} });
		await client.close();

		expect(workspaces.structuredContent).toEqual({
			workspaces: [{ slug: "acme", name: "acme", role: "owner" }],
		});
		expect(agents.outbound).toEqual([]);
	});

	it("serves the consent page with the page policy", async () => {
		const page = await agents.fetch(`${origin}/oauth/consent?client_id=nobody`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-/);
		expect(page.headers.get("x-frame-options")).toBe("DENY");
	});

	it("answers no token with a challenge pointing at the resource metadata", async () => {
		const response = await agents.fetch(`${origin}/mcp`, listTools);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
		const metadata = await agents.fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
		expect(metadata.status).toBe(200);
		expect(((await metadata.json()) as { resource: string }).resource).toBe(`${origin}/mcp`);
	});

	it("answers a bad token with a challenge, not an error", async () => {
		const response = await agents.fetch(`${origin}/mcp`, {
			...listTools,
			headers: { ...listTools.headers, authorization: "Bearer not.a.token" },
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
	});

	it("refuses a session cookie alone", async () => {
		const { headers } = await signUp(agents, origin, "cookie-only");
		const response = await agents.fetch(`${origin}/mcp`, {
			...listTools,
			headers: { ...listTools.headers, cookie: headers.cookie, origin },
		});

		expect(response.status).toBe(401);
	});
});

describe("without BETTER_AUTH_URL", () => {
	it("has no /mcp", async () => {
		const bare = await startAgents(origin, { settings: { BETTER_AUTH_URL: "" } });
		try {
			const response = await bare.fetch(`${origin}/mcp`, listTools);
			expect(response.status).toBe(404);
		} finally {
			await bare.dispose();
		}
	});
});
