import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOAuthMcp } from "../../../apps/web/test/fake-oauth-mcp";
import { conversationName, finishOAuth, startOAuth } from "../src";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const REDIRECT = "https://agents.test/api/mcp-oauth/callback";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("an MCP server connected through OAuth", () => {
	it("is reached with its token, which a turn refreshes when it stops working", async () => {
		const server = new FakeOAuthMcp("mcp.oauth.test");
		const requests = fakeModel(
			(call) =>
				call === 0 ? anthropicToolCall("tracker__whoami", {}) : anthropicStream("You are Ada."),
			{ "mcp.oauth.test": server.handle },
		);
		const workspaceId = crypto.randomUUID();
		const registry = env.REGISTRY.getByName(workspaceId);
		await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const assetId = await registry.createMcpServer({
			name: "tracker",
			transport: "http",
			url: server.mcpUrl,
			headers: [],
		});

		// Connect it as the app does: begin, sign in, take the state, trade the code.
		const begun = await registry.mcpOAuthBegin(assetId, "user-ada");
		if ("status" in begun) throw new Error(begun.message);
		const state = `${workspaceId}.${assetId}.${begun.state}`;
		const url = await startOAuth(registry, assetId, {
			serverUrl: begun.serverUrl,
			redirectUrl: REDIRECT,
			state,
		});
		if (!url) throw new Error("Expected a sign-in URL");
		const { code } = server.approve(url.href);
		expect(await registry.mcpOAuthTakeState(assetId, begun.state, "user-ada")).toBe(true);
		await finishOAuth(registry, assetId, {
			serverUrl: begun.serverUrl,
			redirectUrl: REDIRECT,
			code,
			state,
		});
		await registry.mcpOAuthConnected(assetId, "user-ada");

		// The token stops working before the turn; the turn refreshes it and goes on.
		server.expireAccessTokens();
		const agent = await registry.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			mcpServers: [{ assetId, version: 1, tools: null }],
		});
		const started = await registry.startConversation(agent.id, "user-ada");
		const stub = await getAgentByName(
			env.CONVERSATIONS,
			conversationName(workspaceId, started?.id ?? ""),
		);
		const socket = await connect(stub);
		expect(await ask(socket, "Who am I there?")).toMatchObject({
			text: "You are Ada.",
			error: null,
		});
		socket.close();

		expect(server.bearers).toContain("access-1");
		expect(server.bearers.at(-1)).toBe("access-2");
		expect(JSON.stringify(requests[1]?.body.messages)).toContain("holder of access-2");
		expect(await registry.mcpOAuthOpen(assetId)).toMatchObject({
			tokens: { access_token: "access-2" },
		});
		// The model never saw a token of the connection's but in the tool's own answer.
		expect(JSON.stringify(requests[0]?.body)).not.toContain("refresh-");
	});
});
