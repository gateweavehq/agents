import { env } from "cloudflare:workers";
import type { AgentSnapshot } from "@gateweave/agents-model";
import { getAgentByName } from "agents";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName, listWorkersAiModels } from "../src";
import { languageModel } from "../src/models";
import { FakeMcpServer } from "./fake-mcp";
import { ask, completionStream, connect, fakeModel } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

const TOKEN = "workers-ai-test-token-not-a-real-one";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";
const COMPLETIONS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`;
const FOUND = "what the tool found for them";
const settings = { WORKERS_AI_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };

const SEARCH = {
	name: "search",
	description: "Searches the tracker",
	inputSchema: {
		type: "object" as const,
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};

/** A conversation with a Workers AI agent that pins one MCP server, and no key in the workspace. */
async function conversation() {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	const server = await registry.createMcpServer({
		name: "acme",
		transport: "http",
		url: "https://mcp.acme.dev/mcp",
		headers: [],
	});
	const agent = await registry.createAgent({
		name: "Scout",
		description: null,
		provider: "workers-ai",
		model: SCOUT,
		instructions: null,
		mcpServers: [{ assetId: server, version: 1 }],
	});
	const started = await registry.startConversation(agent.id, "user-ada");
	const stub = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, started?.id ?? ""),
	);
	return { registry, stub };
}

// Workers AI streams usage on every chunk: that chunk's increment, and on the last chunk before
// `[DONE]` the totals for the whole request. The AI SDK keeps the last usage it sees, so the totals
// are what it reports.
function toolCall(query: string): Response {
	return completionStream([
		{
			delta: {
				role: "assistant",
				tool_calls: [
					{ index: 0, id: "call_1", type: "function", function: { name: "acme__search" } },
				],
			},
			usage: { prompt_tokens: 600, completion_tokens: 1 },
		},
		{
			delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query }) } }] },
			usage: { prompt_tokens: 20, completion_tokens: 12 },
		},
		{ delta: {}, finish: "tool_calls", usage: { prompt_tokens: 620, completion_tokens: 13 } },
	]);
}

function answer(text: string): Response {
	return completionStream([
		{
			delta: { role: "assistant", content: text.slice(0, 5) },
			usage: { prompt_tokens: 650, completion_tokens: 3 },
		},
		{ delta: { content: text.slice(5) }, usage: { prompt_tokens: 50, completion_tokens: 17 } },
		{ delta: {}, finish: "stop", usage: { prompt_tokens: 700, completion_tokens: 20 } },
	]);
}

describe("a conversation with a Workers AI agent", () => {
	it("answers with the deployment's token, streams a tool call, and records the totals", async () => {
		const acme = new FakeMcpServer([SEARCH], () => ({ content: [{ type: "text", text: FOUND }] }));
		const requests = fakeModel(
			(call) => (call === 0 ? toolCall("flaky") : answer("Three issues match")),
			{ "mcp.acme.dev": acme.handle },
		);
		const { registry, stub } = await conversation();
		const socket = await connect(stub);
		const turn = await ask(socket, "Which issues are flaky?");
		socket.close();

		expect(turn).toMatchObject({ text: "Three issues match", error: null });
		expect(turn.raw.join("")).not.toContain(TOKEN);

		// Cloudflare's OpenAI-compatible endpoint, with the server's token and no workspace key.
		expect(requests.map((request) => request.url)).toEqual([COMPLETIONS, COMPLETIONS]);
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(requests[0]?.headers.has("cf-aig-gateway-id")).toBe(false);
		expect(requests[0]?.body).toMatchObject({
			model: SCOUT,
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(JSON.stringify(requests[0]?.body.tools)).toContain("acme__search");
		// The tool's result went back to the model.
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(FOUND);
		expect(await registry.listProviderKeys()).toEqual([]);

		// Each request's last chunk holds its totals (620 and 700 in, 13 and 20 out), which is what
		// counts; adding up the chunks' increments would give other numbers.
		const [run] = await registry.listRuns();
		expect(run).toMatchObject({
			status: "succeeded",
			provider: "workers-ai",
			model: SCOUT,
			steps: 2,
			inputTokens: 620 + 700,
			outputTokens: 13 + 20,
			// $0.27 and $0.85 per million tokens, rounded per request: 178 and 206 millionths.
			cost: 178 + 206,
		});
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace).toMatchObject([
			{ kind: "connect" },
			{
				kind: "model",
				step: 0,
				inputTokens: 620,
				outputTokens: 13,
				cost: 178,
				finishReason: "tool-calls",
			},
			{ kind: "tool", tool: "search" },
			{
				kind: "model",
				step: 1,
				inputTokens: 700,
				outputTokens: 20,
				cost: 206,
				finishReason: "stop",
			},
		]);
	});

	it("says the server's token was refused, without repeating what Cloudflare said", async () => {
		fakeModel(() =>
			Response.json(
				{ success: false, errors: [{ message: `bad token ${TOKEN}` }] },
				{ status: 403 },
			),
		);
		const { registry, stub } = await conversation();
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe(
			"Workers AI refused this server's token. Whoever runs the server can check WORKERS_AI_TOKEN.",
		);
		expect(turn.raw.join("")).not.toContain(TOKEN);
		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "failed", inputTokens: 0 });
	});
});

describe("the Workers AI model", () => {
	const agent: AgentSnapshot = {
		agentId: "agent-1",
		name: "Scout",
		provider: "workers-ai",
		model: SCOUT,
		instructions: null,
		sandbox: false,
		engine: "gateweave",
		updatedAt: 0,
	};
	const metadata = { workspace: "w", agent: "agent-1", conversation: "c" };

	/** The first request a model makes, which fails so nothing else is needed. */
	async function firstRequest(model: ReturnType<typeof languageModel>) {
		const requests = fakeModel(() => new Response("{}", { status: 400 }));
		await generateText({ model, prompt: "Hello", maxRetries: 0 }).catch(() => undefined);
		return requests[0];
	}

	it("goes to the REST API directly, naming no gateway when the server has none", async () => {
		const request = await firstRequest(languageModel(agent, null, settings, metadata));
		expect(request?.url).toBe(COMPLETIONS);
		expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(request?.headers.has("cf-aig-metadata")).toBe(false);
	});

	it("keeps to that URL through the server's gateway, naming the gateway in a header", async () => {
		const request = await firstRequest(
			languageModel(
				agent,
				null,
				{
					WORKERS_AI_TOKEN: TOKEN,
					AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/gateweave/`,
					AI_GATEWAY_TOKEN: "gateway-token",
				},
				metadata,
			),
		);
		// The account comes from the gateway's address when none is named.
		expect(request?.url).toBe(COMPLETIONS);
		expect(request?.headers.get("cf-aig-gateway-id")).toBe("gateweave");
		expect(request?.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
		expect(JSON.parse(request?.headers.get("cf-aig-metadata") ?? "{}")).toEqual(metadata);
		expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
	});

	it("is not built on a server that did not turn Workers AI on", () => {
		for (const bare of [{}, { WORKERS_AI_TOKEN: TOKEN }, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }]) {
			expect(() => languageModel(agent, null, bare, metadata)).toThrow(
				"This server does not offer Workers AI",
			);
		}
	});
});

describe("listing Workers AI's models", () => {
	const SEARCH_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search?task=Text+Generation&per_page=200`;
	const model = (name: string, functionCalling?: string) => ({
		id: `id-${name}`,
		name,
		properties: [
			{ property_id: "context_window", value: "128000" },
			...(functionCalling === undefined
				? []
				: [{ property_id: "function_calling", value: functionCalling }]),
		],
	});

	function catalog(status = 200, body: unknown = undefined) {
		const requests: { url: string; headers: Headers }[] = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), headers: new Headers(init?.headers) });
			return Response.json(
				body ?? {
					success: true,
					result: [
						model(SCOUT, "true"),
						model("@cf/meta/llama-2-7b-chat-int8", "false"),
						model("@cf/baai/no-property"),
						model("@cf/openai/gpt-oss-20b", "true"),
					],
					result_info: { page: 1, per_page: 200, total_pages: 1 },
				},
				{ status },
			);
		}) as typeof fetch;
		return { fetcher, requests };
	}

	it("keeps the text models that call tools, asking with the server's token", async () => {
		const { fetcher, requests } = catalog();
		expect(await listWorkersAiModels(settings, fetcher)).toEqual({
			ok: true,
			models: [
				{ id: SCOUT, name: SCOUT },
				{ id: "@cf/openai/gpt-oss-20b", name: "@cf/openai/gpt-oss-20b" },
			],
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(SEARCH_URL);
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
	});

	it("reads on while the catalog has more pages", async () => {
		const pages = [
			{ result: [model("@cf/a/one", "true")], result_info: { page: 1, total_pages: 2 } },
			{ result: [model("@cf/a/two", "true")], result_info: { page: 2, total_pages: 2 } },
		];
		const urls: string[] = [];
		const fetcher = (async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return Response.json(pages[urls.length - 1]);
		}) as typeof fetch;
		const listed = await listWorkersAiModels(settings, fetcher);
		expect(listed.ok && listed.models.map((found) => found.id)).toEqual(["@cf/a/one", "@cf/a/two"]);
		expect(urls[1]).toContain("page=2");
	});

	it("says why in the app's words, never Cloudflare's", async () => {
		const refused = catalog(403, { success: false, errors: [{ message: `token ${TOKEN}` }] });
		expect(await listWorkersAiModels(settings, refused.fetcher)).toEqual({
			ok: false,
			message: "Workers AI refused this server's token",
		});
		expect(await listWorkersAiModels(settings, catalog(500, {}).fetcher)).toEqual({
			ok: false,
			message: "Workers AI answered with an error (500)",
		});
		const down = (async () => {
			throw new TypeError(`fetch failed ${TOKEN}`);
		}) as typeof fetch;
		expect(await listWorkersAiModels(settings, down)).toEqual({
			ok: false,
			message: "Could not reach Workers AI",
		});
	});

	it("asks nothing of a server that did not turn it on", async () => {
		const { fetcher, requests } = catalog();
		for (const bare of [{}, { WORKERS_AI_TOKEN: TOKEN }, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }]) {
			expect(await listWorkersAiModels(bare, fetcher)).toEqual({
				ok: false,
				message: "This server does not offer Workers AI",
			});
		}
		expect(requests).toEqual([]);
	});
});
