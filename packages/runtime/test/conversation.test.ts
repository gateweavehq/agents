import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentSnapshot } from "@gateweave/agents-model";
import { getAgentByName } from "agents";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConversationAgent, conversationName } from "../src";
import { languageModel } from "../src/models";
import { anthropicStream, ask, connect, fakeModel, KEY } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

async function conversation({ key = true } = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
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
	});
	if (key) await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const started = await registry.startConversation(agent.id, "user-ada");
	const id = started?.id ?? "";
	const stub = await getAgentByName(env.CONVERSATIONS, conversationName(workspaceId, id));
	return { registry, id, stub };
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
		expect(turn.raw.join("")).not.toContain("abcd");
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

describe("runs", () => {
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
		expect(JSON.stringify(trace)).not.toContain("abcd");
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
