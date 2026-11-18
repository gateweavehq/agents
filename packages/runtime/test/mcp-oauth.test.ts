import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOAuthMcp } from "../../../apps/web/test/fake-oauth-mcp";
import {
	checkMcpServer,
	conversationName,
	finishOAuth,
	RegistryOAuthProvider,
	startOAuth,
} from "../src";
import type { OAuthStore } from "../src/mcp-oauth";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const REDIRECT = "https://agents.test/api/mcp-oauth/callback";

afterEach(() => {
	vi.restoreAllMocks();
});

it("releases a refresh lease after a malformed successful response", async () => {
	let lease: string | null = null;
	let tokens = { access_token: "old", refresh_token: "same", token_type: "Bearer" };
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: null,
			verifier: null,
			tokens,
		}),
		mcpOAuthSave: async (_, parts) => {
			if (parts.tokens) tokens = parts.tokens as typeof tokens;
			return true;
		},
		mcpRefreshClaim: async () => {
			if (lease) return { kind: "busy" };
			lease = crypto.randomUUID();
			return { kind: "claimed", lease };
		},
		mcpRefreshRelease: async (_, claimed) => {
			if (lease === claimed) lease = null;
		},
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	await provider.tokens();
	const fetchRefresh = provider.fetchWithRefreshLease(
		async () => new Response("not JSON", { status: 200 }),
	);
	const response = await fetchRefresh("https://example.test/token", {
		body: "grant_type=refresh_token&refresh_token=same",
	});
	await expect(response.json()).rejects.toThrow();
	await provider.releaseRefresh();
	expect(lease).toBeNull();
	await provider.releaseRefresh();
	expect(lease).toBeNull();
});

it("stops a refresh waiter on abort", async () => {
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: null,
			verifier: null,
			tokens: { access_token: "old", refresh_token: "same" },
		}),
		mcpOAuthSave: async () => true,
		mcpRefreshClaim: async () => ({ kind: "busy" }),
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	const controller = new AbortController();
	const waiting = provider.fetchWithRefreshLease(fetch)("https://example.test/token", {
		body: "grant_type=refresh_token&refresh_token=same",
		signal: controller.signal,
	});
	controller.abort(new Error("cancelled"));
	await expect(waiting).rejects.toThrow("cancelled");
});

it("caps a refresh wait with a temporary error", async () => {
	let now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: null,
			verifier: null,
			tokens: { access_token: "old", refresh_token: "same" },
		}),
		mcpOAuthSave: async () => true,
		mcpRefreshClaim: async () => {
			now += 20_001;
			return { kind: "busy" };
		},
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	await expect(
		provider.fetchWithRefreshLease(fetch)("https://example.test/token", {
			body: "grant_type=refresh_token&refresh_token=same",
		}),
	).rejects.toThrow("sign-in server is busy");
});

it("adopts a concurrent refresh even when the refresh token does not rotate", async () => {
	let lease: string | null = null;
	let tokens = { access_token: "old", refresh_token: "same", token_type: "Bearer" };
	let requests = 0;
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: null,
			verifier: null,
			tokens,
		}),
		mcpOAuthSave: async (_, parts) => {
			tokens = parts.tokens as typeof tokens;
			return true;
		},
		mcpRefreshClaim: async () => {
			if (lease) return { kind: "busy" };
			lease = crypto.randomUUID();
			return { kind: "claimed", lease };
		},
		mcpRefreshRelease: async (_, claimed) => {
			if (lease === claimed) lease = null;
		},
	};
	const first = new RegistryOAuthProvider(store, "server", {});
	const second = new RegistryOAuthProvider(store, "server", {});
	await Promise.all([first.tokens(), second.tokens()]);
	const fetchFn: typeof fetch = async () => {
		requests++;
		return Response.json({ access_token: "new", refresh_token: "same", token_type: "Bearer" });
	};
	const init = { body: "grant_type=refresh_token&refresh_token=same" };
	const firstResponse = await first.fetchWithRefreshLease(fetchFn)(
		"https://example.test/token",
		init,
	);
	const waiting = second.fetchWithRefreshLease(fetchFn)("https://example.test/token", init);
	await first.saveTokens(await firstResponse.json());
	const secondResponse = await waiting;
	await second.saveTokens(await secondResponse.json());
	expect(requests).toBe(1);
	expect((await first.tokens())?.access_token).toBe("new");
	expect((await second.tokens())?.access_token).toBe("new");
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
		server.expireAccessTokens();
		const secondConversation = await registry.startConversation(agent.id, "user-ada");
		const secondStub = await getAgentByName(
			env.CONVERSATIONS,
			conversationName(workspaceId, secondConversation?.id ?? ""),
		);
		const secondSocket = await connect(secondStub);
		const concurrentTarget = await registry.mcpCheckTarget(assetId);
		if (!concurrentTarget) throw new Error("Expected an MCP target");
		server.keepRefreshToken();
		server.delayRefresh(100);
		const refreshBefore = server.requests.filter((request) => request === "POST /token").length;
		const [turn, health] = await Promise.all([
			ask(secondSocket, "Check this server"),
			checkMcpServer(concurrentTarget, (id) => new RegistryOAuthProvider(registry, id, {})),
		]);
		secondSocket.close();
		expect(turn.error).toBeNull();
		expect(health.ok).toBe(true);
		expect(server.requests.filter((request) => request === "POST /token")).toHaveLength(
			refreshBefore + 1,
		);
		expect(await registry.mcpOAuthOpen(assetId)).toMatchObject({
			tokens: { access_token: "access-3", refresh_token: "refresh-2" },
		});
		server.delayRefresh(0);

		server.expireAccessTokens();
		server.failNextRefresh("invalid-client");
		const target = await registry.mcpCheckTarget(assetId);
		if (!target) throw new Error("Expected an MCP target");
		const failed = await checkMcpServer(
			target,
			(id) => new RegistryOAuthProvider(registry, id, {}),
		);
		expect(failed).toMatchObject({
			ok: false,
			kind: "sign-in-again",
			error: expect.stringContaining("connect it again"),
		});
		expect(await registry.mcpOAuthOpen(assetId)).toMatchObject({ tokens: null });
		// The model never saw a token of the connection's but in the tool's own answer.
		expect(JSON.stringify(requests[0]?.body)).not.toContain("refresh-");
	});
});
