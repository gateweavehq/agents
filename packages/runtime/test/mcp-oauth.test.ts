import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOAuthMcp } from "../../../apps/web/test/fake-oauth-mcp";
import {
	checkMcpServer,
	conversationName,
	finishOAuth,
	OAuthSignInNeeded,
	RegistryOAuthProvider,
	startOAuth,
} from "../src";
import type { OAuthStore } from "../src/mcp-oauth";
import { traced } from "../src/tools";
import type { RunRecorder } from "../src/trace";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const REDIRECT = "https://agents.test/api/mcp-oauth/callback";

afterEach(() => {
	vi.restoreAllMocks();
});

it("invalidates cached health when a connected tool later needs sign-in", async () => {
	let invalidated = false;
	const run = {
		toolStarted: () => "span",
		toolEnded: () => {},
	} as unknown as RunRecorder;
	const tool = traced(
		{
			execute: async () => {
				throw new OAuthSignInNeeded();
			},
		} as unknown as ToolSet[string],
		"server",
		"tool",
		run,
		{
			onSignInFailure: async () => {
				invalidated = true;
			},
		},
	);
	const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
	await expect(execute({}, { toolCallId: "call", messages: [] })).rejects.toThrow();
	expect(invalidated).toBe(true);
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
	expect(lease).toBeNull();
	await provider.releaseRefresh();
	expect(lease).toBeNull();
});

it("does not restore tokens cleared while waiting for a refresh lease", async () => {
	let tokens: { access_token: string; refresh_token: string } | null = {
		access_token: "old",
		refresh_token: "old-refresh",
	};
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
			tokens = null;
			return { kind: "claimed", lease: crypto.randomUUID() };
		},
		mcpRefreshRelease: async () => {},
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	await provider.tokens();
	await expect(
		provider.fetchWithRefreshLease(async () => {
			requests++;
			return Response.json({ access_token: "new" });
		})("https://example.test/token", {
			body: "grant_type=refresh_token&refresh_token=old-refresh",
		}),
	).rejects.toThrow();
	expect(requests).toBe(0);
	expect(tokens).toBeNull();
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

it("honors the caller abort before claiming, while a sent refresh can finish", async () => {
	const controller = new AbortController();
	let claims = 0;
	let finish: ((response: Response) => void) | undefined;
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: null,
			verifier: null,
			tokens: { access_token: "old", refresh_token: "same" },
		}),
		mcpOAuthSave: async () => true,
		mcpRefreshClaim: async () => {
			claims++;
			return { kind: "claimed", lease: crypto.randomUUID() };
		},
		mcpRefreshRelease: async () => {},
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	const aborted = new AbortController();
	aborted.abort(new Error("stopped"));
	await expect(
		provider.fetchWithRefreshLease(fetch, aborted.signal)("https://example.test/token", {
			body: "grant_type=refresh_token&refresh_token=same",
		}),
	).rejects.toThrow("stopped");
	expect(claims).toBe(0);
	const sent = provider.fetchWithRefreshLease(
		async () =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
		controller.signal,
	)("https://example.test/token", { body: "grant_type=refresh_token&refresh_token=same" });
	for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
	expect(finish).toBeDefined();
	controller.abort(new Error("late"));
	finish?.(Response.json({ access_token: "new", refresh_token: "next" }));
	expect((await sent).ok).toBe(true);
});

it("does not clear credentials or a verifier during a health check client rejection", async () => {
	let saves = 0;
	let tokens = { access_token: "old" };
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: { client_id: "old" },
			verifier: "signing-in",
			tokens,
		}),
		mcpOAuthSave: async () => {
			saves++;
			return true;
		},
	};
	const provider = new RegistryOAuthProvider(store, "server", { healthCheck: true });
	await provider.clientInformation();
	tokens = { access_token: "new" };
	await provider.invalidateCredentials("all");
	expect(provider.clientRejected).toBe(true);
	expect(saves).toBe(0);
	expect(tokens.access_token).toBe("new");
});

it("a turn's invalidation compares the credentials it sent with newer saved credentials", async () => {
	let client: unknown = { client_id: "old" };
	let tokens: unknown = { access_token: "old" };
	let verifier: string | null = null;
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({ serverUrl: "https://example.test/mcp", client, tokens, verifier }),
		mcpOAuthSave: async (_, parts) => {
			if (parts.unlessSigningIn && verifier) return false;
			if (
				JSON.stringify(parts.expectedClient) !== JSON.stringify(client) ||
				JSON.stringify(parts.expectedTokens) !== JSON.stringify(tokens)
			)
				return false;
			client = parts.client;
			tokens = parts.tokens;
			return true;
		},
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	await provider.clientInformation();
	client = { client_id: "new" };
	tokens = { access_token: "new" };
	await provider.invalidateCredentials("all");
	expect(client).toEqual({ client_id: "new" });
	expect(tokens).toEqual({ access_token: "new" });
	verifier = "pending-sign-in";
	await provider.invalidateCredentials("all");
	expect(verifier).toBe("pending-sign-in");
});

it("each invalidation scope compares the client and token snapshot", async () => {
	const saved: Parameters<OAuthStore["mcpOAuthSave"]>[1][] = [];
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: { client_id: "client" },
			tokens: { access_token: "token" },
			verifier: "verifier",
		}),
		mcpOAuthSave: async (_, parts) => {
			saved.push(parts);
			return false;
		},
	};
	const provider = new RegistryOAuthProvider(store, "server", { onRedirect: () => {} });
	for (const scope of ["all", "client", "tokens", "verifier"] as const)
		await provider.invalidateCredentials(scope);
	for (const parts of saved) {
		expect(parts.expectedClient).toEqual({ client_id: "client" });
		expect(parts.expectedTokens).toEqual({ access_token: "token" });
	}
	expect(saved.at(-1)?.expectedVerifier).toBe("verifier");
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
			kind: "temporary",
			error: expect.stringContaining("will be checked again"),
		});
		expect(await registry.mcpOAuthOpen(assetId)).toMatchObject({
			tokens: { access_token: "access-4", refresh_token: "refresh-2" },
		});
		await registry.mcpOAuthSave(assetId, {
			tokens: { access_token: "rejected", token_type: "Bearer" },
		});
		const noRefresh = await checkMcpServer(
			target,
			(id) => new RegistryOAuthProvider(registry, id, {}),
		);
		expect(noRefresh).toMatchObject({ ok: false, kind: "sign-in-again" });
		// The model never saw a token of the connection's but in the tool's own answer.
		expect(JSON.stringify(requests[0]?.body)).not.toContain("refresh-");
	});
});
