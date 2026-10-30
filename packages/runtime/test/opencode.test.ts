import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConversationAgent, conversationName } from "../src";
import type { EngineJob } from "../src/engines";
import {
	OPENCODE_INSTRUCTIONS,
	OPENCODE_PLACEHOLDER_KEY,
	OpenCodeTurn,
	openCodeArguments,
	openCodeCommand,
	openCodeConfig,
} from "../src/opencode";
import { decideOutbound } from "../src/outbound";
import { createTraceTables, RunRecorder, readTrace, type Sql } from "../src/trace";
import type { FakeSandbox } from "./fake-sandbox";
import { ask, connect, type Turn } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

const KEY = "sk-ant-secret-abcdefgh";

const SITE = {
	provider: "github" as const,
	externalId: "7",
	installationId: "99",
	owner: "acme",
	name: "site",
	defaultBranch: "main",
	private: true,
};

/** A conversation with an agent whose engine is OpenCode, with an Anthropic model. */
async function conversation({ repository = false }: { repository?: boolean } = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = null] = repository ? await registry.syncRepositories([SITE]) : [];
	const rules = await registry.createLibraryAsset({
		kind: "instructions",
		name: "rules",
		text: "Be brief.\n",
	});
	const agent = await registry.createAgent({
		name: "Builder",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: rules, version: 1 },
		sandbox: true,
		engine: "opencode",
		repositoryId,
	});
	const conversationId = (await registry.startConversation(agent.id, "user-ada"))?.id ?? "";
	const name = conversationName(workspaceId, conversationId);
	const stub = await getAgentByName(env.CONVERSATIONS, name);
	const machine = (env.SANDBOX as unknown as DurableObjectNamespace<FakeSandbox>).getByName(name);
	return { workspaceId, registry, stub, machine, conversationId, agentId: agent.id };
}

/** The chunks of the turn that reached the browser. */
function chunksOf(turn: Turn): unknown[] {
	return turn.raw.flatMap((raw) => {
		const { body } = JSON.parse(raw) as { body?: string };
		return body?.trim() ? [JSON.parse(body)] : [];
	});
}

/** One of OpenCode's events, as `opencode run --format json` writes it. */
function event(type: string, part: object = {}): string {
	return JSON.stringify({ type, timestamp: 1, sessionID: "ses_1", part });
}

/** A step's usage, as OpenCode reports it: the cached input and the reasoning apart. */
function finish(
	reason: string,
	tokens: { input: number; output: number; reasoning?: number; read?: number; write?: number },
): string {
	return event("step_finish", {
		type: "step-finish",
		reason,
		cost: 0,
		tokens: {
			total: 0,
			input: tokens.input,
			output: tokens.output,
			reasoning: tokens.reasoning ?? 0,
			cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
		},
	});
}

const start = event("step_start", { type: "step-start" });

function text(words: string): string {
	return event("text", { type: "text", text: words, time: { start: 1, end: 2 } });
}

/** A tool call, which OpenCode prints once it has its result, `took` milliseconds after it began. */
function tool(
	id: string,
	name: string,
	input: object,
	result: { output: string } | { error: string },
	took = 100,
): string {
	return event("tool_use", {
		type: "tool",
		callID: id,
		tool: name,
		state: {
			status: "output" in result ? "completed" : "error",
			input,
			...result,
			metadata: {},
			title: "",
			time: { start: 1_000, end: 1_000 + took },
		},
	});
}

/** A turn that lists the files, then answers: two requests to the model. */
const LISTING = [
	start,
	text("Let me look. "),
	tool("toolu_1", "bash", { command: "ls", description: "List" }, { output: "a.txt\nb.txt\n" }),
	finish("tool-calls", { input: 1_000, output: 40, reasoning: 10, read: 3_000, write: 500 }),
	start,
	text("There are two files."),
	finish("stop", { input: 200, output: 30, read: 4_000 }),
];

function errorEvent(error: object): string {
	return JSON.stringify({ type: "error", timestamp: 1, sessionID: "ses_1", error });
}

describe("an agent whose engine is OpenCode", () => {
	it("runs OpenCode in its sandbox, and passes on its text, tool calls and each request's usage", async () => {
		const { workspaceId, registry, stub, machine, conversationId, agentId } = await conversation({
			repository: true,
		});
		await machine.scriptEngine({ lines: LISTING });
		const socket = await connect(stub);
		const turn = await ask(socket, "List the files");
		socket.close();

		expect(turn).toMatchObject({ text: "Let me look. There are two files.", error: null });
		expect(turn.raw.join("\n")).toContain("opencode__bash");
		const seen = await machine.seen();
		expect(seen.checkouts).toMatchObject([{ branch: `gateweave/${conversationId}` }]);
		expect(seen.engine).toMatchObject([
			{
				engine: "opencode",
				prompt: "List the files",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				cwd: "/workspace/repo",
				access: {
					key: KEY,
					metadata: { workspace: workspaceId, agent: agentId, conversation: conversationId },
				},
			},
		]);
		expect(seen.engine[0]?.system).toContain("Be brief.");

		const [run] = await registry.listRuns();
		// Each request priced on its own: the cached input at its rates, the reasoning as output.
		expect(run).toMatchObject({
			status: "succeeded",
			steps: 2,
			inputTokens: 4_500 + 4_200,
			outputTokens: 50 + 30,
			cachedInputTokens: 3_000 + 4_000,
			cost: 1_000 * 2 + 3_000 * 0.1 + 500 * 2.5 + 50 * 10 + (200 * 2 + 4_000 * 0.1 + 30 * 10),
		});
		const trace = await stub.runTrace(run?.id ?? "");
		const models = trace.filter((span) => span.kind === "model");
		expect(models).toMatchObject([
			{ step: 0, status: "ok", finishReason: "tool-calls", inputTokens: 4_500 },
			{ step: 1, status: "ok", finishReason: "stop", inputTokens: 4_200 },
		]);
		const tools = trace.filter((span) => span.kind === "tool");
		expect(tools).toMatchObject([
			{ step: 0, status: "ok", server: "opencode", tool: "bash", error: null },
		]);
		// The model had answered once the tool began, which OpenCode says only once it ends.
	});

	it("ends a request's span when its first tool began, by how long OpenCode says the tool took", async () => {
		const { registry, stub, agentId } = await conversation();
		const agent = await registry.agentSnapshot(agentId);
		if (!agent) throw new Error("The agent is missing");
		const spans = await runInDurableObject(stub, (instance: ConversationAgent) => {
			const sql = instance.sql.bind(instance) as Sql;
			createTraceTables(sql);
			const run = new RunRecorder(sql, "run-1", agent, 10_000);
			const turn = new OpenCodeTurn({ write() {} }, run, agent);
			turn.take(start, 10_000);
			// The model had answered at 12,000, when the tests began; OpenCode prints them at 15,000.
			turn.take(tool("toolu_1", "bash", { command: "npm test" }, { output: "ok" }, 3_000), 15_000);
			turn.take(finish("tool-calls", { input: 10, output: 2 }), 15_100);
			turn.take(start, 15_200);
			turn.take(finish("stop", { input: 20, output: 4 }), 16_000);
			return readTrace(sql, "run-1");
		});
		expect(spans).toMatchObject([
			{ kind: "model", step: 0, startedAt: 10_000, endedAt: 12_000 },
			{ kind: "tool", step: 0, startedAt: 12_000, endedAt: 15_000 },
			{ kind: "model", step: 1, startedAt: 15_200, endedAt: 16_000 },
		]);
	});

	it("shows a tool that failed as failed, with OpenCode's words", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [
				start,
				tool("toolu_1", "read", { filePath: "/nope" }, { error: "File not found: /nope" }),
				finish("tool-calls", { input: 100, output: 5 }),
				start,
				text("It is not there."),
				finish("stop", { input: 120, output: 5 }),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Read it");
		socket.close();

		expect(chunksOf(turn)).toContainEqual(
			expect.objectContaining({
				type: "tool-output-error",
				toolCallId: "toolu_1",
				errorText: "File not found: /nope",
			}),
		);
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ status: "error", tool: "read", error: "File not found: /nope" },
		]);
	});

	it("shows Gateweave's tools in the chat under their own names, and leaves their spans to them", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [
				start,
				tool(
					"toolu_1",
					"gateweave_acme__search",
					{ query: "flaky" },
					{ output: JSON.stringify({ issues: ["TRK-1"] }) },
				),
				finish("tool-calls", { input: 100, output: 5 }),
				start,
				text("TRK-1 is flaky."),
				finish("stop", { input: 120, output: 5 }),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Which issues are flaky?");
		socket.close();

		expect(turn).toMatchObject({ text: "TRK-1 is flaky.", error: null });
		const chunks = chunksOf(turn);
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "tool-input-available", toolName: "acme__search" }),
		);
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "tool-output-available", output: { issues: ["TRK-1"] } }),
		);
		expect(turn.raw.join("\n")).not.toContain("opencode__");
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toEqual([]);
	});

	it("fails the turn in the app's words when Anthropic refuses the key, never quoting it", async () => {
		const { registry, stub, machine } = await conversation();
		const refusal =
			"Anthropic refused the workspace's key. An owner or admin can check it in Settings.";
		// As OpenCode 1.19.5 reports Anthropic's 401, which no step began for.
		await machine.scriptEngine({
			lines: [
				errorEvent({
					name: "APIError",
					data: {
						message: "invalid x-api-key sk-ant-****lder",
						statusCode: 401,
						isRetryable: false,
						responseBody:
							'{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key sk-ant-****lder"}}',
					},
				}),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe(refusal);
		expect(turn.raw.join("\n")).not.toContain("sk-ant");
		expect((await registry.listRuns())[0]).toMatchObject({ status: "failed", error: refusal });
	});

	it("names the billing when the provider refuses the key for it", async () => {
		const { stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [
				errorEvent({
					name: "APIError",
					data: {
						message: "Your credit balance is too low to access the Anthropic API.",
						statusCode: 400,
					},
				}),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe(
			"Anthropic refused the workspace's key for its billing. An owner can check the account.",
		);
	});

	it("fails a request that broke off, and quotes OpenCode with anything like a key taken out", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [
				start,
				errorEvent({
					name: "UnknownError",
					data: { message: "socket closed by sk-ant-abc****xyz" },
				}),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		const words = "OpenCode could not finish: socket closed by [key]";
		expect(turn.error).toBe(words);
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "model")).toMatchObject([
			{ status: "error", error: words },
		]);
	});

	it("fails the turn when OpenCode stops before its request finishes", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({ lines: [start, text("Working on it.")] });
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe("OpenCode stopped before it finished.");
		expect((await registry.listRuns())[0]).toMatchObject({ status: "failed" });
	});

	it("says the sandbox likely ran out of memory when OpenCode is killed before its first event", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({ lines: [], exit: { code: 137, seconds: 90, log: "" } });
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		const words =
			"OpenCode was killed before it finished, most likely because the sandbox ran out of memory.";
		expect(turn.error).toBe(words);
		expect((await registry.listRuns())[0]).toMatchObject({ status: "failed", error: words });
	});

	it("quotes the end of OpenCode's log when it exits without saying why", async () => {
		const { registry, stub, machine } = await conversation();
		const log = "Error: Unable to connect. Is the computer able to access the url?";
		await machine.scriptEngine({ lines: [], exit: { code: 1, seconds: 3, log } });
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		const words = `OpenCode stopped before it finished (exit status 1). The end of its log:\n${log}`;
		expect(turn.error).toBe(words);
		expect((await registry.listRuns())[0]).toMatchObject({ status: "failed", error: words });
	});
});

describe("OpenCode's command", () => {
	const job: EngineJob = {
		engine: "opencode",
		prompt: "And the folders?",
		history: "The person: List the files",
		system: "Be brief.",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		cwd: "/workspace",
		access: { key: KEY, metadata: { workspace: "w", agent: "a", conversation: "c" }, tools: null },
	};
	const config = (command: { env: Record<string, string> }) =>
		JSON.parse(command.env.OPENCODE_CONFIG_CONTENT ?? "{}");

	it("runs it headless and unasked, with the message on its input, and names a new session", () => {
		const fresh = openCodeArguments({ provider: "openai", model: "gpt-5.5", resume: false });
		expect(fresh).toEqual([
			"run",
			"--format",
			"json",
			"--model",
			"openai/gpt-5.5",
			"--auto",
			"--title",
			"Gateweave",
		]);
		const resumed = openCodeArguments({ provider: "openai", model: "gpt-5.5", resume: true });
		expect(resumed.slice(-1)).toEqual(["--continue"]);
		expect(resumed).not.toContain("--title");
	});

	it("is `opencode`, with the message after the conversation so far when it lost the session", () => {
		const fresh = openCodeCommand(job, false);
		expect(fresh.argv[0]).toBe("opencode");
		expect(fresh.input).toContain("The person: List the files");
		expect(fresh.input.endsWith("And the folders?")).toBe(true);
		expect(openCodeCommand(job, true).input).toBe("And the folders?");
	});

	it("calls the agent's model alone, at its provider's own address, with the placeholder", () => {
		expect(config(openCodeCommand(job, false))).toMatchObject({
			model: "anthropic/claude-sonnet-5-5",
			small_model: "anthropic/claude-sonnet-5-5",
			enabled_providers: ["anthropic"],
			provider: {
				anthropic: {
					options: { baseURL: "https://api.anthropic.com/v1", apiKey: OPENCODE_PLACEHOLDER_KEY },
					models: { "claude-sonnet-5-5": {} },
				},
			},
		});
		const openai = openCodeConfig({
			provider: "openai",
			model: "gpt-5.5",
			instructions: false,
			tools: false,
		});
		expect(openai).toMatchObject({
			provider: { openai: { options: { baseURL: "https://api.openai.com/v1" } } },
		});
		expect(() =>
			openCodeConfig({ provider: "google", model: "gemini-3", instructions: false, tools: false }),
		).toThrow("OpenCode does not call Google's models here");
	});

	it("keeps out what would leave the sandbox, and the tools whose requests the trace would miss", () => {
		const command = openCodeCommand(job, false);
		expect(config(command)).toMatchObject({
			autoupdate: false,
			share: "disabled",
			snapshot: false,
			tools: { task: false, webfetch: false },
		});
		expect(command.env).toMatchObject({
			OPENCODE_DISABLE_AUTOUPDATE: "1",
			OPENCODE_DISABLE_MODELS_FETCH: "1",
			OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
			OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
		});
		expect(JSON.stringify(command)).not.toContain(KEY);
	});

	it("reads the turn's instructions from the file the sandbox writes, when there are any", () => {
		expect(config(openCodeCommand(job, false)).instructions).toEqual([OPENCODE_INSTRUCTIONS]);
		expect(config(openCodeCommand({ ...job, system: "" }, false))).not.toHaveProperty(
			"instructions",
		);
	});

	it("names Gateweave's MCP server only when the turn has tools, for as long as the turn may run", () => {
		expect(config(openCodeCommand(job, false))).not.toHaveProperty("mcp");
		const tools = { conversation: "c", token: "t" };
		expect(
			config(openCodeCommand({ ...job, access: { ...job.access, tools } }, false)),
		).toMatchObject({
			mcp: {
				gateweave: {
					type: "remote",
					url: "http://tools.gateweave.internal/mcp",
					oauth: false,
					timeout: 3_600_000,
				},
			},
		});
	});
});

describe("the providers' APIs from the sandbox", () => {
	it("are open to OpenCode's requests for the model of the agent's provider alone", () => {
		const messages = new URL("https://api.anthropic.com/v1/messages");
		const responses = new URL("https://api.openai.com/v1/responses");
		expect(decideOutbound("POST", messages, null, "anthropic")).toEqual({
			allow: true,
			credentials: "anthropic",
		});
		expect(decideOutbound("POST", responses, null, "anthropic")).toMatchObject({
			allow: false,
			reason:
				"api.openai.com is reachable from this sandbox only while a turn calls OpenAI's models",
		});
		expect(decideOutbound("POST", responses, null, "openai")).toEqual({
			allow: true,
			credentials: "openai",
		});
		expect(decideOutbound("POST", messages, null, "google")).toMatchObject({ allow: false });
	});
});
