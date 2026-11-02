import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { FakeOAuthMcp } from "./fake-oauth-mcp";

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
