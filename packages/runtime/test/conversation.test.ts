import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentSnapshot } from "@gateweave/agents-model";
import { getAgentByName } from "agents";
import { applyChunkToParts } from "agents/chat";
import { generateText, type UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConversationAgent, conversationName, destroyConversationObject } from "../src";
import { languageModel } from "../src/models";
import { FakeMcpServer } from "./fake-mcp";
import { anthropicStream, ask, closeCode, connect, fakeModel, KEY, SESSION } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

/** An MCP server that never answers: a request to it waits until its caller gives up. */
function silentServer() {
	const asked: Request[] = [];
	const handle = (request: Request) => {
		asked.push(request);
		return new Promise<Response>((_resolve, reject) => {
			const giveUp = () => reject(request.signal.reason ?? new Error("Aborted"));
			if (request.signal.aborted) giveUp();
			else request.signal.addEventListener("abort", giveUp, { once: true });
		});
	};
	return { asked, handle };
}

async function conversation({ key = true, server = false } = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	const mcpServers = server
		? [
				{
					assetId: await registry.createMcpServer({
						name: "acme",
						transport: "http",
						url: "https://mcp.acme.dev/mcp",
						headers: [],
					}),
					version: 1,
					tools: null,
				},
			]
		: [];
	const rules = await registry.createLibraryAsset({
		kind: "instructions",
		name: "rules",
		text: "Answer in one word.\n",
	});
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: rules, version: 1 },
		mcpServers,
	});
	if (key) await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const started = await registry.startConversation(agent.id, "user-ada");
	const id = started?.id ?? "";
	const stub = await getAgentByName(env.CONVERSATIONS, conversationName(workspaceId, id));
	return { registry, id, stub, agentId: agent.id, workspaceId };
}

describe("a conversation", () => {
	it("answers with the agent's model and instructions, using the workspace's key", async () => {
		const { registry, id, stub } = await conversation();
		const requests = fakeModel(() => anthropicStream("Looks good."));
		const socket = await connect(stub);

		const turn = await ask(socket, "Review my change, please");
		expect(turn).toMatchObject({ text: "Looks good.", error: null });
		expect(turn.raw.join("")).not.toContain(KEY);

		const [request] = requests;
		expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(request?.headers.get("x-api-key")).toBe(KEY);
		expect(request?.body.model).toBe("claude-sonnet-5-5");
		expect(request?.body.cache_control).toEqual({ type: "ephemeral" });
		expect(JSON.stringify(request?.body.system)).toContain("Answer in one word.");
		expect(JSON.stringify(request?.body.messages)).toContain("Review my change, please");

		// The messages stay with the conversation, and the registry titles it after the first.
		const stored = (await (await stub.fetch("http://conversation/get-messages")).json()) as {
			role: string;
			parts: { type: string; text?: string }[];
		}[];
		expect(stored.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(stored[1]?.parts.find((part) => part.type === "text")?.text).toBe("Looks good.");
		expect((await registry.getConversation(id, "user-ada"))?.title).toBe(
			"Review my change, please",
		);
		socket.close();
	});

	it("takes no message once its socket's session has run out, nor on a socket without one", async () => {
		const { stub } = await conversation();
		const requests = fakeModel(() => anthropicStream("Never sent"));

		const expired = await connect(stub, { ...SESSION, expiresAt: Date.now() - 1 });
		const closing = closeCode(expired);
		void ask(expired, "Delete the repository").catch(() => {});
		expect(await closing).toBe(4401);

		const anonymous = await connect(stub, null);
		expect(await closeCode(anonymous)).toBe(4401);
		expect(requests).toHaveLength(0);
	});

	it("says why it cannot answer when the workspace has no key", async () => {
		const { stub } = await conversation({ key: false });
		const requests = fakeModel(() => anthropicStream("Never sent"));
		const socket = await connect(stub);

		const turn = await ask(socket, "Hello");
		expect(turn.error).toBe(
			"The workspace has no Anthropic key, so Reviewer cannot answer. An owner or admin can add one in Settings.",
		);
		expect(requests).toEqual([]);
		socket.close();
	});

	it("says the provider refused the key, without repeating what the provider said", async () => {
		const { stub } = await conversation();
		fakeModel(() =>
			Response.json(
				{
					type: "error",
					error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` },
				},
				{ status: 401 },
			),
		);
		const socket = await connect(stub);

		const turn = await ask(socket, "Hello");
		expect(turn.error).toBe(
			"Anthropic refused the workspace's key. An owner or admin can check it in Settings.",
		);
		expect(turn.raw.join("")).not.toContain("wxyz");
		socket.close();
	});

	it("stops the model's request when the turn is stopped", async () => {
		const { stub } = await conversation();
		const requests = fakeModel(() => anthropicStream("Thinking", { end: false }));
		const socket = await connect(stub);

		const id = crypto.randomUUID();
		const turn = ask(socket, "Take your time", id);
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id }));
		await vi.waitFor(() => expect(requests[0]?.signal?.aborted).toBe(true));
		await turn;
		socket.close();
	});
});

describe("data parts", () => {
	it("stores and replays data parts with the conversation", async () => {
		const { stub } = await conversation();
		fakeModel(() => anthropicStream("Done."));
		const socket = await connect(stub);
		await ask(socket, "Run the checks");

		// What a turn's stream leaves behind once `applyChunkToParts` has turned its data chunks
		// into parts: what a rich reply (a PR card, the run's summary) is stored as.
		const before = (await (
			await stub.fetch("http://conversation/get-messages")
		).json()) as UIMessage[];
		await stub.persistMessages([
			...before,
			{
				id: crypto.randomUUID(),
				role: "assistant",
				parts: [
					{ type: "text", text: "Done." },
					{ type: "data-run", data: { runId: "run-1", steps: 3 } },
					{ type: "data-changes", data: { files: 2, added: 40 } },
				],
			},
		]);

		const stored = (await (await stub.fetch("http://conversation/get-messages")).json()) as {
			role: string;
			parts: { type: string; data?: unknown }[];
		}[];
		const last = stored.at(-1);
		expect(last?.role).toBe("assistant");
		expect(last?.parts).toContainEqual({ type: "data-run", data: { runId: "run-1", steps: 3 } });
		expect(last?.parts).toContainEqual({ type: "data-changes", data: { files: 2, added: 40 } });
		socket.close();
	});

	it("does not store transient data parts, which is what live progress writes", () => {
		// `applyChunkToParts` is the assembly the chat server runs on every stream chunk
		// (`agents/chat`, which `@cloudflare/ai-chat` calls), so a part it does not keep is
		// never stored.
		const parts: UIMessage["parts"] = [];
		const progress = { type: "data-progress", data: { step: "tests" }, transient: true };
		expect(applyChunkToParts(parts, progress)).toBe(true);
		expect(parts).toEqual([]);

		const run = { type: "data-run", data: { runId: "run-1" } };
		expect(applyChunkToParts(parts, run)).toBe(true);
		expect(parts).toEqual([
			expect.objectContaining({ type: "data-run", data: { runId: "run-1" } }),
		]);
	});

	it("says what the turn is doing before its first token, and never stores it", async () => {
		const { stub } = await conversation({ server: true });
		const mcp = new FakeMcpServer(
			[{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
			() => ({ content: [{ type: "text", text: "pong" }] }),
		);
		fakeModel(() => anthropicStream("Done."), { "mcp.acme.dev": (request) => mcp.handle(request) });
		const socket = await connect(stub);

		const turn = await ask(socket, "Hello");
		expect(turn).toMatchObject({ text: "Done.", error: null });
		// Connecting the servers is the one wait a turn with them has before its model answers.
		// Each frame's body holds one chunk as JSON text, quotes escaped.
		expect(turn.raw.join("")).toContain("data-progress");
		expect(turn.raw.join("")).toContain("Connecting tools");

		const stored = (await (await stub.fetch("http://conversation/get-messages")).json()) as {
			parts: { type: string }[];
		}[];
		expect(stored.at(-1)?.parts.some((part) => part.type === "data-progress")).toBe(false);
		socket.close();
	});

	it("stops before its first model request when a pause lands while its servers connect", async () => {
		const { registry, stub, agentId, workspaceId } = await conversation({ server: true });
		const mcp = new FakeMcpServer(
			[{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
			() => ({ content: [{ type: "text", text: "pong" }] }),
		);
		let paused = false;
		const requests = fakeModel(() => anthropicStream("Done."), {
			"mcp.acme.dev": async (request) => {
				if (!paused) {
					paused = true;
					await env.REGISTRY.getByName(workspaceId).pauseAgent(agentId, "admin");
				}
				return mcp.handle(request);
			},
		});
		const socket = await connect(stub);

		const turn = await ask(socket, "Hello");
		socket.close();
		expect(requests).toHaveLength(0);
		expect(turn.error).toContain("The agent was paused");
		expect((await registry.listRuns())[0]).toMatchObject({
			status: "stopped",
			error: "The agent was paused, so the run stopped before its next model request.",
		});
	});

	it("does not retry a failed provider call once the agent is paused", async () => {
		const { registry, stub, agentId, workspaceId } = await conversation();
		// The first attempt fails with a retryable error, and the pause lands before the retry.
		const requests = fakeModel(() => {
			void env.REGISTRY.getByName(workspaceId).pauseAgent(agentId, "admin");
			return new Response(
				JSON.stringify({ type: "error", error: { type: "api_error", message: "Overloaded" } }),
				{
					status: 529,
					headers: { "content-type": "application/json" },
				},
			);
		});
		const socket = await connect(stub);

		const turn = await ask(socket, "Hello");
		socket.close();
		expect(requests).toHaveLength(1);
		expect(turn.error).toContain("The agent was paused");
		expect((await registry.listRuns())[0]).toMatchObject({
			status: "stopped",
			error: "The agent was paused, so the run stopped before its next model request.",
		});
	});

	it("ties its reply to its run, so the chat can sum it up and link to it", async () => {
		const { stub } = await conversation();
		fakeModel(() => anthropicStream("Done."));
		const socket = await connect(stub);

		const turn = await ask(socket, "Hello");
		expect(turn).toMatchObject({ text: "Done.", error: null });
		// The part is not transient, so history keeps it and a reopened chat still links the run.
		expect(turn.raw.join("")).toContain("data-run");

		const stored = (await (await stub.fetch("http://conversation/get-messages")).json()) as {
			parts: { type: string; data?: { runId?: unknown } }[];
		}[];
		const run = stored.at(-1)?.parts.find((part) => part.type === "data-run");
		expect(typeof run?.data?.runId).toBe("string");
		socket.close();
	});

	it("answers with the text of the reply its run part names, for get_run", async () => {
		const { stub } = await conversation();
		fakeModel(() => anthropicStream("Done."));
		const socket = await connect(stub);

		await ask(socket, "Hello");
		const stored = (await (await stub.fetch("http://conversation/get-messages")).json()) as {
			parts: { type: string; data?: { runId?: unknown } }[];
		}[];
		const runId = stored.at(-1)?.parts.find((part) => part.type === "data-run")?.data?.runId;
		expect(typeof runId).toBe("string");

		expect(await stub.runAnswer(runId as string)).toBe("Done.");
		expect(await stub.runAnswer("no-such-run")).toBeNull();
		socket.close();
	});
});

describe("destroying a conversation's object", () => {
	it("counts the object aborting itself as done, which is how Cloudflare can answer", async () => {
		const conversation = { destroy: () => Promise.reject(new Error("destroyed")) };

		await expect(destroyConversationObject(conversation)).resolves.toBeUndefined();
	});

	it("passes on any other failure, since the object may still hold everything", async () => {
		const failure = new Error("Network connection lost.");
		const conversation = { destroy: () => Promise.reject(failure) };

		await expect(destroyConversationObject(conversation)).rejects.toBe(failure);
	});

	it("does not take a longer message that mentions it for the same thing", async () => {
		const conversation = {
			destroy: () => Promise.reject(new Error("the sandbox could not be destroyed")),
		};

		await expect(destroyConversationObject(conversation)).rejects.toThrow("could not be destroyed");
	});

	it("empties a real object, whichever way the answer comes", async () => {
		const name = conversationName("destroying", crypto.randomUUID());
		const stub = await getAgentByName(env.CONVERSATIONS, name);
		await runInDurableObject(stub as never, async (_instance, state) => {
			await state.storage.put("words", "these go");
		});

		await destroyConversationObject(stub);

		// The object aborts itself just after answering here, so a call right away can still meet that.
		const left = await vi.waitFor(async () => {
			const again = await getAgentByName(env.CONVERSATIONS, name);
			return runInDurableObject(again as never, async (_instance, state) =>
				state.storage.get("words"),
			);
		});
		expect(left).toBeUndefined();
	});
});

describe("runs", () => {
	it("record Anthropic cache writes and reads on the model span at their own prices", async () => {
		const { registry, stub } = await conversation();
		const requests = fakeModel(() =>
			anthropicStream("Looks good.", { cacheRead: 60, cacheWrite: 20 }),
		);
		const socket = await connect(stub);
		await ask(socket, "Review my change, please");
		socket.close();

		expect(requests[0]?.body.cache_control).toEqual({ type: "ephemeral" });
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		// Per million input tokens, Sonnet 5.5 charges $2 for ordinary input, $0.10 for reads,
		// and $2.50 for writes.
		expect(trace).toMatchObject([
			{
				kind: "model",
				inputTokens: 90,
				cachedInputTokens: 60,
				cacheWriteInputTokens: 20,
				outputTokens: 5,
				cost: 10 * 2 + 60 * 0.1 + 20 * 2.5 + 5 * 10,
			},
		]);
		expect(run).toMatchObject({ inputTokens: 90, cachedInputTokens: 60, cost: 126 });
	});

	it("record each turn with its tokens and cost, and keep the trace with the conversation", async () => {
		const { registry, stub } = await conversation();
		fakeModel(() => anthropicStream("Looks good.", { headers: { "cf-aig-log-id": "log-123" } }));
		const socket = await connect(stub);
		await ask(socket, "Review my change, please");
		socket.close();

		const [run] = await registry.listRuns();
		// Sonnet 5.5 at $2 and $10 per million tokens: 10 tokens in, 5 out.
		expect(run).toMatchObject({
			status: "succeeded",
			agentName: "Reviewer",
			steps: 1,
			inputTokens: 10,
			outputTokens: 5,
			cost: 10 * 2 + 5 * 10,
		});
		expect(run?.endedAt).toBeGreaterThanOrEqual(run?.startedAt ?? 0);

		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace).toMatchObject([
			{
				kind: "model",
				step: 0,
				status: "ok",
				model: "claude-sonnet-5-5",
				inputTokens: 10,
				outputTokens: 5,
				cost: 70,
				finishReason: "stop",
				gatewayLogId: "log-123",
				error: null,
			},
		]);
		expect(await stub.runTrace("another-run")).toEqual([]);
	});

	it("record why a turn failed, in the app's words", async () => {
		const { registry, stub } = await conversation();
		fakeModel(() =>
			Response.json(
				{ type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } },
				{ status: 401 },
			),
		);
		const socket = await connect(stub);
		await ask(socket, "Hello");
		socket.close();

		const [run] = await registry.listRuns();
		expect(run).toMatchObject({
			status: "failed",
			error: "Anthropic refused the workspace's key. An owner or admin can check it in Settings.",
			inputTokens: 0,
		});
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace).toMatchObject([{ status: "error" }]);
		expect(JSON.stringify(trace)).not.toContain("wxyz");
	});

	it("record a stopped turn as stopped", async () => {
		const { registry, stub } = await conversation();
		const requests = fakeModel(() => anthropicStream("Thinking", { end: false }));
		const socket = await connect(stub);
		const id = crypto.randomUUID();
		const turn = ask(socket, "Take your time", id);
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id }));
		await turn;
		await vi.waitFor(async () => expect((await registry.listRuns())[0]?.status).toBe("stopped"));
		socket.close();
	});

	it("record a turn stopped before its reply began as stopped, with no request the model gets", async () => {
		const { registry, stub } = await conversation({ server: true });
		const acme = silentServer();
		const requests = fakeModel(() => anthropicStream("Never sent"), {
			"mcp.acme.dev": acme.handle,
		});
		const socket = await connect(stub);
		const id = crypto.randomUUID();
		const turn = ask(socket, "Take your time", id);
		// The turn waits for its MCP server, so nothing of its reply has been sent.
		await vi.waitFor(() => expect(acme.asked).toHaveLength(1));
		socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id }));
		await turn;
		await vi.waitFor(async () => expect((await registry.listRuns())[0]?.status).toBe("stopped"));
		// The stand-in for `fetch` takes any request; a real one refuses a request stopped already.
		expect(requests.filter((request) => request.signal?.aborted !== true)).toEqual([]);
		socket.close();
	});

	it("close the runs a restart cut short as interrupted when the conversation wakes", async () => {
		const { registry, stub } = await conversation();
		fakeModel(() => anthropicStream("Thinking", { end: false }));
		const socket = await connect(stub);
		void ask(socket, "Take your time");
		await vi.waitFor(async () => expect(await registry.listRuns()).toHaveLength(1));
		const [run] = await registry.listRuns();
		await vi.waitFor(async () => expect(await stub.runTrace(run?.id ?? "")).toHaveLength(1));

		// What the next wake does after a restart, which the test cannot cause.
		await runInDurableObject(stub, (instance: ConversationAgent) => instance.onStart());
		expect((await registry.getRun(run?.id ?? ""))?.status).toBe("interrupted");
		expect(await stub.runTrace(run?.id ?? "")).toMatchObject([{ status: "error" }]);
		socket.close();
	});
});

describe("models", () => {
	const agent = (provider: AgentSnapshot["provider"], model: string): AgentSnapshot => ({
		agentId: "agent-1",
		name: "Reviewer",
		provider,
		model,
		instructions: null,
		sandbox: false,
		memory: false,
		engine: "gateweave",
		updatedAt: 0,
	});
	const metadata = { workspace: "w", agent: "agent-1", conversation: "c" };
	const gateway = {
		AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/account-1/gateweave/",
		AI_GATEWAY_TOKEN: "gateway-token",
	};

	/** The first request a model makes, which fails so nothing else is needed. */
	async function firstRequest(model: ReturnType<typeof languageModel>) {
		const requests = fakeModel(() => new Response("{}", { status: 400 }));
		await generateText({ model, prompt: "Hello", maxRetries: 0 }).catch(() => undefined);
		return requests[0];
	}

	it("go through the deployment's AI Gateway when it names one, with the workspace's key", async () => {
		const anthropic = await firstRequest(
			languageModel(agent("anthropic", "claude-sonnet-5-5"), "ant-key", gateway, metadata),
		);
		expect(anthropic?.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/account-1/gateweave/anthropic/v1/messages",
		);
		expect(anthropic?.headers.get("x-api-key")).toBe("ant-key");
		expect(anthropic?.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
		expect(JSON.parse(anthropic?.headers.get("cf-aig-metadata") ?? "{}")).toEqual(metadata);

		const openai = await firstRequest(
			languageModel(agent("openai", "gpt-5.5"), "oai-key", gateway, metadata),
		);
		expect(openai?.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/account-1/gateweave/openai/responses",
		);
		expect(openai?.headers.get("authorization")).toBe("Bearer oai-key");

		const google = await firstRequest(
			languageModel(agent("google", "gemini-3-pro"), "goog-key", gateway, metadata),
		);
		expect(google?.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/account-1/gateweave/google-ai-studio/v1beta/models/gemini-3-pro:generateContent",
		);
		expect(google?.headers.get("x-goog-api-key")).toBe("goog-key");
	});

	it("go straight to the provider without a gateway, and refuse an address that is not one", async () => {
		const direct = await firstRequest(
			languageModel(agent("openai", "gpt-5.5"), "oai-key", {}, metadata),
		);
		expect(direct?.url).toBe("https://api.openai.com/v1/responses");
		expect(direct?.headers.has("cf-aig-metadata")).toBe(false);

		expect(() =>
			languageModel(
				agent("openai", "gpt-5.5"),
				"oai-key",
				{ AI_GATEWAY_URL: "https://example.com/v1/a/b" },
				metadata,
			),
		).toThrow("This server's AI_GATEWAY_URL is not an AI Gateway address");
	});
});
