import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";
import { sealerFor } from "../src/secrets";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const ADA = "user-ada";
const GRACE = "user-grace";
const TOKENS = {
	access_token: "acme-access-token",
	refresh_token: "acme-refresh",
	token_type: "Bearer",
};

async function workspace() {
	const stub = registry();
	await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
	const server = await stub.createMcpServer({
		name: "acme",
		transport: "http",
		url: "https://mcp.acme.dev/mcp",
		headers: [],
	});
	const agent = await stub.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		mcpServers: [{ assetId: server, version: 1, tools: null }],
	});
	const conversation = (await stub.startConversation(agent.id, ADA))?.id ?? "";
	return { stub, server, conversation };
}

async function connect(stub: ReturnType<typeof registry>, server: string) {
	const begun = await stub.mcpOAuthBegin(server, ADA);
	if ("status" in begun) throw new Error(begun.message);
	expect(await stub.mcpOAuthTakeState(server, begun.state, ADA)).toBe(true);
	await stub.mcpOAuthSave(server, { client: { client_id: "gateweave" }, tokens: TOKENS });
	await stub.mcpOAuthConnected(server, ADA);
}

describe("MCP servers connected through OAuth", () => {
	it("retains connection metadata when tokens are cleared, then removes it on disconnect", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		await stub.mcpOAuthSave(server, { tokens: null, expectedTokens: TOKENS });
		expect(
			(await stub.listMcpServers()).find((item) => item.asset.id === server)?.oauth?.current,
		).toBe(true);
		await stub.mcpOAuthDisconnect(server);
		expect(
			(await stub.listMcpServers()).find((item) => item.asset.id === server)?.oauth,
		).toBeNull();
	});

	it("rejects a stale health completion and invalidates a turn's cached result", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		const first = await stub.mcpHealthClaim(server);
		if (first.kind !== "claimed") throw new Error("Expected a lease");
		await stub.mcpOAuthSave(server, { tokens: null, expectedTokens: TOKENS });
		expect(
			await stub.mcpHealthComplete(server, { state: "connected" }, first.generation, first.lease),
		).toBe(false);
		const second = await stub.mcpHealthClaim(server);
		if (second.kind !== "claimed") throw new Error("Expected another lease");
		expect(
			await stub.mcpHealthComplete(
				server,
				{ state: "needs-reconnecting" },
				second.generation,
				second.lease,
			),
		).toBe(true);
		expect((await stub.mcpHealthClaim(server)).kind).toBe("cached");
		await stub.mcpHealthInvalidate(server);
		expect((await stub.mcpHealthClaim(server)).kind).toBe("claimed");
	});

	it("compares both client and tokens before clearing credentials", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		await stub.mcpOAuthSave(server, {
			client: { client_id: "new" },
			tokens: { ...TOKENS, access_token: "new" },
		});
		expect(
			await stub.mcpOAuthSave(server, {
				client: null,
				tokens: null,
				expectedClient: { client_id: "gateweave" },
				expectedTokens: TOKENS,
			}),
		).toBe(false);
		expect(await stub.mcpOAuthOpen(server)).toMatchObject({
			client: { client_id: "new" },
			tokens: { access_token: "new" },
		});
	});

	it("does not clear a verifier that a newer sign-in saved", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		await stub.mcpOAuthSave(server, { verifier: "first" });
		await stub.mcpOAuthSave(server, { verifier: "new-sign-in" });
		expect(await stub.mcpOAuthSave(server, { verifier: null, expectedVerifier: "first" })).toBe(
			false,
		);
		expect((await stub.mcpOAuthOpen(server))?.verifier).toBe("new-sign-in");
	});

	it("accepts a conditional save after opening renews fallback-key tokens", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		await runInDurableObject(stub, async (_instance: RegistryDO, state) => {
			const sealer = await sealerFor(
				{ BETTER_AUTH_SECRET: "test-only-auth-secret-that-signs-nothing-0123" },
				state.id.toString(),
			);
			if ("unavailable" in sealer) throw new Error(sealer.unavailable);
			const sealed = await sealer.seal(`mcp-oauth/${server}/tokens`, JSON.stringify(TOKENS));
			state.storage.sql.exec(
				"UPDATE mcp_oauth SET sealed_tokens = ? WHERE asset_id = ?",
				sealed,
				server,
			);
		});
		expect(
			await stub.mcpOAuthSave(server, {
				tokens: { ...TOKENS, access_token: "rotated" },
				expectedTokens: TOKENS,
			}),
		).toBe(true);
		expect((await stub.mcpOAuthOpen(server))?.tokens).toMatchObject({ access_token: "rotated" });
	});

	it("does not clear an active sign-in's client or tokens", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		await stub.mcpOAuthBegin(server, ADA);
		expect(
			await stub.mcpOAuthSave(server, {
				client: null,
				tokens: null,
				expectedClient: { client_id: "gateweave" },
				expectedTokens: TOKENS,
				unlessSigningIn: true,
			}),
		).toBe(false);
		expect(await stub.mcpOAuthOpen(server)).toMatchObject({
			client: { client_id: "gateweave" },
			tokens: TOKENS,
		});
	});
	it("opens nested JSON and warns without logging a rejected value", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		const nested = { jwks: [{ keys: [{ kid: "key-1", use: "sig" }] }] };
		await stub.mcpOAuthSave(server, {
			client: nested,
			tokens: TOKENS,
			authorizationServer: nested,
		});
		expect(await stub.mcpOAuthOpen(server)).toMatchObject({
			client: nested,
			authorizationServer: nested,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await stub.mcpOAuthSave(server, { client: "private-bad-value" });
			expect((await stub.mcpOAuthOpen(server))?.client).toBeNull();
			expect(warn).toHaveBeenCalledWith("mcp-oauth-invalid-json", { part: "client" });
			expect(JSON.stringify(warn.mock.calls)).not.toContain("private-bad-value");
		} finally {
			warn.mockRestore();
		}
	});

	it("keeps a running health lease during token rotation and rejects stale completion", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		const claim = await stub.mcpHealthClaim(server);
		if (claim.kind !== "claimed") throw new Error("Expected a health lease");
		await stub.mcpOAuthSave(server, {
			tokens: { ...TOKENS, access_token: "new" },
			expectedTokens: TOKENS,
		});
		expect((await stub.mcpHealthClaim(server)).kind).toBe("busy");
		await stub.mcpHealthComplete(server, { state: "connected" }, claim.generation, claim.lease);
		expect((await stub.mcpHealthClaim(server)).kind).toBe("cached");
		await stub.mcpOAuthSave(server, {
			tokens: null,
			expectedTokens: { ...TOKENS, access_token: "new" },
		});
		expect((await stub.mcpHealthClaim(server)).kind).toBe("claimed");
	});
	it("does not clear rotated tokens from a concurrent refresh", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		const claim = await stub.mcpHealthClaim(server);
		if (claim.kind !== "claimed") throw new Error("Health lease was not claimed");
		await stub.mcpHealthComplete(
			server,
			{ state: "needs-reconnecting" },
			claim.generation,
			claim.lease,
		);
		expect((await stub.mcpHealthClaim(server)).kind).toBe("cached");
		const fresh = { ...TOKENS, access_token: "fresh-access", refresh_token: "fresh-refresh" };
		expect(await stub.mcpOAuthSave(server, { tokens: fresh })).toBe(true);
		expect((await stub.mcpHealthClaim(server)).kind).toBe("claimed");
		expect(await stub.mcpOAuthSave(server, { tokens: null, expectedTokens: TOKENS })).toBe(false);
		expect((await stub.mcpOAuthOpen(server))?.tokens).toEqual(fresh);
	});

	it("shares the check lease across agents and rejects a completion from before an edit", async () => {
		const { stub, server } = await workspace();
		const first = await stub.mcpHealthClaim(server, "agent-one");
		if (first.kind !== "claimed") throw new Error("Expected a lease");
		expect((await stub.mcpHealthClaim(server, "agent-two")).kind).toBe("busy");
		await stub.editMcpServer({
			assetId: server,
			transport: "http",
			url: "https://new.example/mcp",
			headers: [],
		});
		expect((await stub.mcpHealthClaim(server, "agent-two")).kind).toBe("busy");
		await stub.mcpHealthComplete(
			server,
			{ state: "connected" },
			first.generation,
			first.lease,
			Date.now(),
			"agent-one",
		);
		const second = await stub.mcpHealthClaim(server, "agent-two");
		if (second.kind !== "claimed") throw new Error("Expected a new lease");
		await stub.mcpHealthComplete(
			server,
			{ state: "needs-reconnecting" },
			second.generation,
			second.lease,
			Date.now(),
			"agent-two",
		);
		expect((await stub.mcpHealthClaim(server, "agent-one")).kind).toBe("claimed");
		expect(await stub.mcpHealthClaim(server, "agent-two")).toMatchObject({
			kind: "cached",
			state: "needs-reconnecting",
		});
	});

	it("keep the flow's state single-use, for whoever started it, for ten minutes", async () => {
		const { stub, server } = await workspace();
		const begun = await stub.mcpOAuthBegin(server, ADA);
		if ("status" in begun) throw new Error(begun.message);
		expect(begun.serverUrl).toBe("https://mcp.acme.dev/mcp");
		expect(begun.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);

		// Someone else, or a wrong state, uses it up without succeeding.
		expect(await stub.mcpOAuthTakeState(server, begun.state, GRACE)).toBe(false);
		expect(await stub.mcpOAuthTakeState(server, begun.state, ADA)).toBe(false);

		const again = await stub.mcpOAuthBegin(server, ADA);
		if ("status" in again) throw new Error(again.message);
		expect(await stub.mcpOAuthTakeState(server, "forged", ADA)).toBe(false);
		expect(await stub.mcpOAuthTakeState(server, again.state, ADA)).toBe(false);

		const late = await stub.mcpOAuthBegin(server, ADA);
		if ("status" in late) throw new Error(late.message);
		await runInDurableObject(stub, (instance: RegistryDO) => {
			const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
			sql.exec("UPDATE mcp_oauth SET state_expires_at = 1");
		});
		expect(await stub.mcpOAuthTakeState(server, late.state, ADA)).toBe(false);

		const good = await stub.mcpOAuthBegin(server, ADA);
		if ("status" in good) throw new Error(good.message);
		expect(await stub.mcpOAuthTakeState(server, good.state, ADA)).toBe(true);
	});

	it("seal what the client keeps, and open it only for the app's provider", async () => {
		const { stub, server } = await workspace();
		await connect(stub, server);
		expect(await stub.mcpOAuthOpen(server)).toMatchObject({
			serverUrl: "https://mcp.acme.dev/mcp",
			client: { client_id: "gateweave" },
			tokens: TOKENS,
			verifier: null,
		});
		const stored = await runInDurableObject(stub, (instance: RegistryDO) => {
			const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
			return JSON.stringify(sql.exec("SELECT * FROM mcp_oauth").toArray());
		});
		expect(stored).not.toContain("acme-access-token");
		expect(stored).not.toContain("acme-refresh");
		expect(JSON.stringify(await stub.listMcpServers())).not.toContain("acme-access-token");
	});

	it("are used by turns while the server keeps its URL, and shown on the MCP page", async () => {
		const { stub, server, conversation } = await workspace();
		const before = await stub.beginTurn(conversation, "Hello");
		if ("status" in before) throw new Error(before.message);
		expect(before.mcpServers[0]).not.toHaveProperty("oauth");

		await connect(stub, server);
		const after = await stub.beginTurn(conversation, "Hello");
		if ("status" in after) throw new Error(after.message);
		expect(after.mcpServers[0]).toMatchObject({ name: "acme", oauth: server });
		expect(JSON.stringify(after)).not.toContain("acme-access-token");
		const [entry] = await stub.listMcpServers();
		expect(entry?.oauth).toMatchObject({ connectedBy: ADA, current: true });

		// The server moves: the connection is not sent there, and the page says so.
		await stub.editMcpServer({
			assetId: server,
			transport: "http",
			url: "https://elsewhere.example/mcp",
			headers: [],
		});
		const moved = await stub.mcpCheckTarget(server);
		expect(moved).not.toHaveProperty("oauth");
		expect((await stub.listMcpServers())[0]?.oauth).toMatchObject({ current: false });

		// Disconnecting forgets it.
		expect(await stub.mcpOAuthDisconnect(server)).toBe(true);
		expect(await stub.mcpOAuthOpen(server)).toBeNull();
		expect((await stub.listMcpServers())[0]?.oauth).toBeNull();
	});

	it("are only for remote servers in the library", async () => {
		const stub = registry();
		expect(await stub.mcpOAuthBegin("missing", ADA)).toMatchObject({
			status: "refused",
			message: "That MCP server is not in the library",
		});
	});
});
