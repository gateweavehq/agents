import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

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
