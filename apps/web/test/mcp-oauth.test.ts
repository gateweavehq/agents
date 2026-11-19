import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { FakeOAuthMcp } from "./fake-oauth-mcp";
import { callServerFn } from "./server-fn";

const origin = "https://agents.test";
const server = new FakeOAuthMcp("mcp.oauth.test");

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { hosts: { "mcp.oauth.test": server.handle } });
});

afterAll(async () => {
	await agents?.dispose();
});

/** A workspace whose owner added the OAuth server to the library. */
async function workspace(slug: string) {
	const owner = await signUp(agents, origin, `owner-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const assetId = await registry.createMcpServer({
		name: "tracker",
		transport: "http",
		url: server.mcpUrl,
		headers: [],
	});
	return { owner, workspaceId, registry, assetId };
}

const get = (path: string, cookie: string) =>
	agents.fetch(`${origin}${path}`, { headers: { cookie }, redirect: "manual" });

it("connects a server through its OAuth sign-in, with PKCE, and keeps the tokens sealed", async () => {
	const { owner, registry, assetId } = await workspace("oauth-lab");
	const cookie = owner.headers.cookie;

	const start = await get(`/api/mcp-oauth/connect?workspace=oauth-lab&server=${assetId}`, cookie);
	expect(start.status).toBe(302);
	const authorization = start.headers.get("location") ?? "";
	// It found the server's authorization server and registered the app as a client first.
	expect(server.requests).toEqual(
		expect.arrayContaining(["POST /register", expect.stringMatching(/^GET \/\.well-known/)]),
	);
	const { code, state, redirect } = server.approve(authorization);
	expect(redirect).toBe(`${origin}/api/mcp-oauth/callback`);

	const back = await get(`/api/mcp-oauth/callback?${new URLSearchParams({ code, state })}`, cookie);
	expect(back.headers.get("location")).toBe("/oauth-lab/mcp?oauth=connected");
	const [entry] = await registry.listMcpServers();
	expect(entry?.oauth).toMatchObject({ connectedBy: owner.userId, current: true });
	expect(await registry.mcpOAuthOpen(assetId)).toMatchObject({
		tokens: { access_token: "access-1" },
	});
	// The page shows who connected it, by name, and none of the tokens.
	const page = (await (await get("/oauth-lab/mcp", cookie)).text()).replaceAll("<!-- -->", "");
	expect(page).toContain("Connected by owner-oauth-lab");
	expect(page).not.toContain("access-1");
	expect(page).not.toContain("refresh-1");

	// The state was used up: the same answer again connects nothing.
	const replay = await get(
		`/api/mcp-oauth/callback?${new URLSearchParams({ code, state })}`,
		cookie,
	);
	expect(replay.headers.get("location")).toBe("/oauth-lab/mcp?oauth=expired");

	// A turn reaches the server with the connection.
	expect(await registry.mcpCheckTarget(assetId)).toMatchObject({ oauth: assetId });
	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
	const health = () =>
		callServerFn(agents, origin, "getMcpOAuthHealth", {
			data: { slug: "oauth-lab" },
			cookie,
			client: owner.headers["cf-connecting-ip"],
			method: "GET",
		});
	const healthy = await health();
	expect(healthy.text).toContain("connected");
	expect(healthy.text).not.toContain("access-1");
	expect(healthy.text).not.toContain("refresh-1");
	const requestsAfterFirst = server.requests.length;
	const cached = await health();
	expect(cached.text).toContain("connected");
	expect(server.requests.length).toBe(requestsAfterFirst);
	const stale = async () => {
		await registry.mcpOAuthSave(assetId, {
			tokens: await registry.mcpOAuthOpen(assetId).then((open) => open?.tokens),
		});
	};

	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		mcpServers: [{ assetId, version: 1, tools: null }],
	});
	const agentHealth = () =>
		callServerFn(agents, origin, "getMcpOAuthHealth", {
			data: { slug: "oauth-lab", agentIds: [agent.id] },
			cookie,
			client: owner.headers["cf-connecting-ip"],
			method: "GET",
		});
	server.expireAccessTokens();
	await stale();
	const refreshBefore = server.requests.filter((request) => request === "POST /token").length;
	const [refreshed, concurrent] = await Promise.all([health(), agentHealth()]);
	expect(server.requests.filter((request) => request === "POST /token")).toHaveLength(
		refreshBefore + 1,
	);
	expect(refreshed.text).toContain("connected");
	expect(concurrent.text).toContain("connected");
	expect(await registry.mcpOAuthOpen(assetId)).toMatchObject({
		tokens: { access_token: "access-2" },
	});
	const requestsAfterRefresh = server.requests.length;
	await health();
	expect(server.requests.length).toBe(requestsAfterRefresh);
	server.denyMcp(403);
	await stale();
	const forbidden = await health();
	expect(forbidden.text).toContain("could-not-check");
	expect(forbidden.text).not.toContain("needs-reconnecting");
	server.denyMcp(null);

	await registry.mcpOAuthSave(assetId, { verifier: "pending-sign-in" });
	server.expireAccessTokens();
	server.failNextRefresh("503");
	await stale();
	const unavailable = await health();
	expect(unavailable.text).toContain("could-not-check");
	expect(unavailable.text).not.toContain("needs-reconnecting");
	expect(unavailable.text).toContain("Its sign-in server did not answer; it will be checked again");
	expect((await registry.mcpOAuthOpen(assetId))?.verifier).toBe("pending-sign-in");
	server.failNextRefresh("network");
	await stale();
	const network = await health();
	expect(network.text).toContain("could-not-check");
	expect(network.text).toContain("Its sign-in server did not answer; it will be checked again");
	expect((await registry.mcpOAuthOpen(assetId))?.verifier).toBe("pending-sign-in");
	server.failNextRefresh("malformed");
	await stale();
	const malformed = await health();
	expect(malformed.text).toContain("could-not-check");
	expect(malformed.text).toContain("Its sign-in server did not answer; it will be checked again");
	const afterMalformedLease = await registry.mcpRefreshClaim(assetId);
	expect(afterMalformedLease.kind).toBe("claimed");
	if (afterMalformedLease.kind === "claimed")
		await registry.mcpRefreshRelease(assetId, afterMalformedLease.lease);
	server.failNextRefresh("503");
	await stale();
	const afterMalformed = await health();
	expect(afterMalformed.text).toContain("could-not-check");
	expect(afterMalformed.text).toContain(
		"Its sign-in server did not answer; it will be checked again",
	);

	server.expireAccessTokens();
	server.revokeRefreshTokens();
	await stale();
	const revoked = await health();
	expect(revoked.text).toContain("needs-reconnecting");
	expect(revoked.text).not.toContain("access-2");
	await registry.mcpOAuthSave(assetId, { tokens: null });
	const missing = await health();
	expect(missing.text).toContain("needs-reconnecting");
	const cachedMissing = await health();
	expect(cachedMissing.text).toContain("needs-reconnecting");
	expect(cachedMissing.text).toBe(missing.text);

	const stranger = await signUp(agents, origin, "stranger-oauth-health");
	const outside = await callServerFn(agents, origin, "getMcpOAuthHealth", {
		data: { slug: "oauth-lab" },
		cookie: stranger.headers.cookie,
		client: stranger.headers["cf-connecting-ip"],
		method: "GET",
	});
	expect(outside.text).not.toContain(assetId);
	expect(outside.text).not.toContain("access-");
	expect(JSON.stringify(agents.logs)).not.toContain("access-2");
	expect(JSON.stringify(agents.logs)).not.toContain("refresh-2");
});

it("lets only the admin who started it finish, and nobody else start it", async () => {
	const { owner, workspaceId, assetId } = await workspace("oauth-guild");
	const start = await get(
		`/api/mcp-oauth/connect?workspace=oauth-guild&server=${assetId}`,
		owner.headers.cookie,
	);
	const { code, state } = server.approve(start.headers.get("location") ?? "");

	// A member who is not an admin can neither start nor finish it.
	const member = await signUp(agents, origin, "member-oauth-guild");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, member.userId, Date.now())
		.run();
	const theirs = await get(
		`/api/mcp-oauth/connect?workspace=oauth-guild&server=${assetId}`,
		member.headers.cookie,
	);
	expect(theirs.headers.get("location")).toBe("/oauth-guild/mcp?oauth=forbidden");
	const stolen = await get(
		`/api/mcp-oauth/callback?${new URLSearchParams({ code, state })}`,
		member.headers.cookie,
	);
	expect(stolen.headers.get("location")).toBe("/oauth-guild/mcp?oauth=forbidden");

	// Someone outside the workspace learns nothing of it.
	const stranger = await signUp(agents, origin, "stranger-oauth-guild");
	const outside = await get(
		`/api/mcp-oauth/callback?${new URLSearchParams({ code, state })}`,
		stranger.headers.cookie,
	);
	expect(outside.status).toBe(404);

	// A forged state is refused.
	const forged = await get(
		`/api/mcp-oauth/callback?${new URLSearchParams({ code, state: `${workspaceId}.${assetId}.forged` })}`,
		owner.headers.cookie,
	);
	expect(forged.headers.get("location")).toBe("/oauth-guild/mcp?oauth=expired");
});
