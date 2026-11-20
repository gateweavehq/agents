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
import { connectTools, traced } from "../src/tools";
import type { RunRecorder } from "../src/trace";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const REDIRECT = "https://agents.test/api/mcp-oauth/callback";

afterEach(() => {
	vi.restoreAllMocks();
});

it("invalidates cached health when a connected tool later needs sign-in", async () => {
	let invalidated = false;
	const run = {
		targets: { tainted: false },
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

it("keeps the tool error when health invalidation fails", async () => {
	const run = {
		targets: { tainted: false },
		toolStarted: () => "span",
		toolEnded: () => {},
	} as unknown as RunRecorder;
	const error = new OAuthSignInNeeded();
	const tool = traced(
		{
			execute: async () => {
				throw error;
			},
		} as unknown as ToolSet[string],
		"server",
		"tool",
		run,
		{
			onSignInFailure: async () => {
				throw new Error("RPC failed");
			},
		},
	);
	await expect(tool.execute?.({}, { toolCallId: "call", messages: [] } as never)).rejects.toBe(
		error,
	);
});

it("keeps sibling cleanup available when connect health invalidation fails", async () => {
	const bad = new FakeOAuthMcp("bad.test");
	let closed = 0;
	fakeModel(() => anthropicStream("unused"), {
		"bad.test": bad.handle,
		"good.test": async (request) => {
			if (request.method === "DELETE") {
				closed++;
				return new Response(null, { status: 204 });
			}
			const message = (await request.json()) as { id?: number; method: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
			return Response.json(
				{
					jsonrpc: "2.0",
					id: message.id,
					result:
						message.method === "initialize"
							? {
									protocolVersion: "2025-11-25",
									capabilities: { tools: {} },
									serverInfo: { name: "good", version: "1" },
								}
							: { tools: [{ name: "search", inputSchema: { type: "object" } }] },
				},
				message.method === "initialize" ? { headers: { "mcp-session-id": "good-session" } } : {},
			);
		},
	});
	const store: OAuthStore = {
		mcpOAuthOpen: async () => {
			throw new OAuthSignInNeeded();
		},
		mcpOAuthSave: async () => true,
		mcpHealthInvalidate: async () => {
			throw new Error("RPC failed");
		},
	};
	const failures: string[] = [];
	const run = {
		serverConnecting: () => "span",
		serverConnected: () => {},
		serverFailed: (_span: string, failure: string) => {
			failures.push(failure);
		},
	} as unknown as RunRecorder;
	const connected = await connectTools(
		[
			{ name: "good", transport: "http", url: "https://good.test/mcp", headers: {}, tools: null },
			{ name: "bad", transport: "http", url: bad.mcpUrl, headers: {}, tools: null, oauth: "bad" },
		],
		run,
		undefined,
		null,
		() => new RegistryOAuthProvider(store, "bad", {}),
	);
	expect(failures).toEqual([expect.stringContaining("OAuth connection")]);
	expect(connected.tools.good__search).toBeDefined();
	await connected.close();
	expect(closed).toBe(1);
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

it("refuses credentials moved to a different server URL", async () => {
	let opens = 0;
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: ++opens === 1 ? "https://a.test/mcp" : "https://b.test/mcp",
			client: null,
			verifier: null,
			tokens: { access_token: "b-secret", refresh_token: "refresh" },
		}),
		mcpOAuthSave: async () => true,
		mcpRefreshClaim: async () => ({ kind: "claimed", lease: crypto.randomUUID() }),
		mcpRefreshRelease: async () => {},
	};
	const provider = new RegistryOAuthProvider(store, "server", { serverUrl: "https://a.test/mcp" });
	await provider.tokens();
	let requests = 0;
	await expect(
		provider.fetchWithRefreshLease(async () => {
			requests++;
			return Response.json({ access_token: "bad" });
		})("https://a.test/token", { body: "grant_type=refresh_token&refresh_token=refresh" }),
	).rejects.toThrow(OAuthSignInNeeded);
	expect(requests).toBe(0);
});

it("refuses B's credentials before opening a client for A", async () => {
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://b.test/mcp",
			client: null,
			verifier: null,
			tokens: { access_token: "b-secret" },
		}),
		mcpOAuthSave: async () => true,
	};
	const provider = new RegistryOAuthProvider(store, "server", { serverUrl: "https://a.test/mcp" });
	await expect(provider.tokens()).rejects.toThrow(OAuthSignInNeeded);
	await expect(provider.storedTokens()).rejects.toThrow(OAuthSignInNeeded);
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

it("does not send a refresh after abort during the post-claim read", async () => {
	const controller = new AbortController();
	let sent = 0;
	let released = 0;
	let opens = 0;
	const store: OAuthStore = {
		mcpOAuthOpen: async () => {
			if (++opens === 2) controller.abort(new Error("stopped"));
			return {
				serverUrl: "https://example.test/mcp",
				client: null,
				verifier: null,
				tokens: { access_token: "old", refresh_token: "same" },
			};
		},
		mcpOAuthSave: async () => true,
		mcpRefreshClaim: async () => ({ kind: "claimed", lease: crypto.randomUUID() }),
		mcpRefreshRelease: async () => {
			released++;
		},
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	await expect(
		provider.fetchWithRefreshLease(async () => {
			sent++;
			return Response.json({});
		}, controller.signal)("https://example.test/token", {
			body: "grant_type=refresh_token&refresh_token=same",
		}),
	).rejects.toThrow("stopped");
	expect(sent).toBe(0);
	expect(released).toBe(1);
});

it("honors the caller abort before claiming, while a sent refresh can finish", async () => {
	const controller = new AbortController();
	let claims = 0;
	let finish: ((response: Response) => void) | undefined;
	let saved: unknown;
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: null,
			verifier: null,
			tokens: { access_token: "old", refresh_token: "same" },
		}),
		mcpOAuthSave: async (_, parts) => {
			saved = parts.tokens;
			return true;
		},
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
		async (_input, init) =>
			new Promise<Response>((resolve, reject) => {
				finish = resolve;
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
				if (init?.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
			}),
		controller.signal,
	)("https://example.test/token", { body: "grant_type=refresh_token&refresh_token=same" });
	for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
	expect(finish).toBeDefined();
	controller.abort(new Error("late"));
	finish?.(Response.json({ access_token: "new", refresh_token: "next" }));
	const response = await sent;
	expect(response.ok).toBe(true);
	await provider.saveTokens(
		(await response.json()) as { access_token: string; token_type: string },
	);
	expect(saved).toMatchObject({ access_token: "new", refresh_token: "next" });
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
	expect(saved).toHaveLength(4);
	for (const [index, parts] of saved.entries()) {
		expect(parts.expectedClient).toEqual({ client_id: "client" });
		expect(parts.expectedTokens).toEqual({ access_token: "token" });
		expect(parts).toMatchObject(
			[
				{ client: null, tokens: null, unlessSigningIn: true },
				{ client: null, unlessSigningIn: true },
				{ tokens: null },
				{ verifier: null, expectedVerifier: "verifier" },
			][index] ?? {},
		);
	}
	expect(saved.at(-1)?.expectedVerifier).toBe("verifier");
});

it("keeps an adopted access-only token set without saving SDK-filled credentials", async () => {
	const old = {
		access_token: "old",
		refresh_token: "old-refresh",
		token_type: "Bearer",
		authorization_server: "https://old.test",
	};
	const adopted = { access_token: "new", token_type: "Bearer" };
	let current: unknown = old;
	let saves = 0;
	let opens = 0;
	const store: OAuthStore = {
		mcpOAuthOpen: async () => ({
			serverUrl: "https://example.test/mcp",
			client: null,
			verifier: null,
			tokens: current,
		}),
		mcpOAuthSave: async (_, parts) => {
			saves++;
			current = parts.tokens;
			return true;
		},
		mcpRefreshClaim: async () => {
			if (++opens === 1) current = adopted;
			return { kind: "claimed", lease: crypto.randomUUID() };
		},
		mcpRefreshRelease: async () => {},
	};
	const provider = new RegistryOAuthProvider(store, "server", {});
	await provider.tokens();
	const response = await provider.fetchWithRefreshLease(async () => {
		throw new Error("unexpected POST");
	})("https://example.test/token", { body: "grant_type=refresh_token&refresh_token=old-refresh" });
	expect(await response.json()).toEqual(adopted);
	await provider.saveTokens({
		...adopted,
		refresh_token: "old-refresh",
		authorization_server: "https://old.test",
	} as never);
	expect(saves).toBe(0);
	expect(current).toEqual(adopted);
});

it("refreshes a tool after the connection deadline has passed", async () => {
	const server = new FakeOAuthMcp("mcp.oauth.test");
	fakeModel(() => anthropicStream("unused"), { "mcp.oauth.test": server.handle });
	const registry = env.REGISTRY.getByName(crypto.randomUUID());
	const assetId = await registry.createMcpServer({
		name: "tracker",
		transport: "http",
		url: server.mcpUrl,
		headers: [],
	});
	const begun = await registry.mcpOAuthBegin(assetId, "user-ada");
	if ("status" in begun) throw new Error(begun.message);
	const flow = { serverUrl: begun.serverUrl, redirectUrl: REDIRECT, state: begun.state };
	const url = await startOAuth(registry, assetId, flow);
	if (!url) throw new Error("Expected sign-in URL");
	const { code } = server.approve(url.href);
	expect(await registry.mcpOAuthTakeState(assetId, begun.state, "user-ada")).toBe(true);
	await finishOAuth(registry, assetId, { ...flow, code });
	await registry.mcpOAuthConnected(assetId, "user-ada");
	const target = await registry.mcpCheckTarget(assetId);
	if (!target) throw new Error("Expected target");
	const run = {
		serverConnecting: () => "span",
		serverConnected: () => {},
		serverFailed: () => {},
		targets: { tainted: false },
		toolStarted: () => "tool",
		toolEnded: () => {},
	} as unknown as RunRecorder;
	const connected = await connectTools(
		[target],
		run,
		undefined,
		null,
		(id) => new RegistryOAuthProvider(registry, id, {}),
	);
	try {
		server.expireAccessTokens();
		await new Promise((resolve) => setTimeout(resolve, 10_050));
		const tool = connected.tools.tracker__whoami;
		expect(tool).toBeDefined();
		await expect(
			tool?.execute?.({}, { toolCallId: "call", messages: [] } as never),
		).resolves.toBeDefined();
		expect((await registry.mcpOAuthOpen(assetId))?.tokens).toMatchObject({
			access_token: "access-2",
		});
		server.denyInvalidBearer();
		const rejected = await checkMcpServer(
			target,
			(id) => new RegistryOAuthProvider(registry, id, {}),
		);
		expect(rejected).toMatchObject({ ok: false, kind: "sign-in-again" });
	} finally {
		await connected.close();
	}
}, 20_000);

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
	it("registers a new client after a finish-time invalid_client", async () => {
		const server = new FakeOAuthMcp("mcp.oauth.test");
		fakeModel(() => anthropicStream("unused"), { "mcp.oauth.test": server.handle });
		const registry = env.REGISTRY.getByName(crypto.randomUUID());
		const assetId = await registry.createMcpServer({
			name: "tracker",
			transport: "http",
			url: server.mcpUrl,
			headers: [],
		});
		const begin = async () => {
			const begun = await registry.mcpOAuthBegin(assetId, "user-ada");
			if ("status" in begun) throw new Error(begun.message);
			const state = `workspace.${assetId}.${begun.state}`;
			const url = await startOAuth(registry, assetId, {
				serverUrl: begun.serverUrl,
				redirectUrl: REDIRECT,
				state,
			});
			if (!url) throw new Error("Expected a sign-in URL");
			const { code } = server.approve(url.href);
			expect(await registry.mcpOAuthTakeState(assetId, begun.state, "user-ada")).toBe(true);
			return { serverUrl: begun.serverUrl, redirectUrl: REDIRECT, code, state };
		};
		const first = await begin();
		server.rejectClient("client-1");
		await expect(finishOAuth(registry, assetId, first)).rejects.toThrow();
		expect((await registry.mcpOAuthOpen(assetId))?.client).toBeNull();
		expect((await registry.mcpOAuthOpen(assetId))?.verifier).toBeNull();
		const second = await begin();
		expect((await registry.mcpOAuthOpen(assetId))?.client).toMatchObject({ client_id: "client-2" });
		await finishOAuth(registry, assetId, second);
		expect((await registry.mcpOAuthOpen(assetId))?.tokens).toMatchObject({
			access_token: "access-1",
		});
	});

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
