/**
 * Codex as an agent's engine (`./engines.ts`): OpenAI's Codex CLI, run in the conversation's
 * sandbox in place of Gateweave's own loop. It reads the repository's AGENTS.md as it would on a
 * laptop. Its events name no model request, so a turn is one model span, with the turn's usage;
 * each of its commands, patches and MCP calls is a tool span. One conversation is one Codex
 * thread, which each turn resumes while the sandbox has it.
 *
 * Gateweave's tools reach it as the MCP server `gateweave` (`./engine-tools.ts`). Their calls come
 * to the chat under their own names, and record their own spans, as in Gateweave's loop.
 *
 * Checked 2026-10-29 against Codex 0.165.0, in its source (the tag `rust-v0.165.0`) and with the
 * CLI against a fake Responses API:
 * - `codex exec`, `exec resume` and their flags: `codex-rs/exec/src/cli.rs`. `-c` takes a TOML value
 *   for a key of `config.toml`, after `exec` and `resume` as before them
 * - the events: `codex-rs/exec/src/exec_events.rs`. `turn.completed` has the thread's usage so far,
 *   which a resumed thread carries on from (`usage_from_last_total` in
 *   `event_processor_with_jsonl_output.rs`), and its input counts the cached input too
 * - OpenAI's built-in provider ignores `OPENAI_BASE_URL`, opens a WebSocket to the Responses API
 *   first and lists models at chatgpt.com. A provider of Gateweave's own (`model_providers`) sends
 *   only `POST /v1/responses`, compactions included, with the key from its `env_key`
 * - MCP servers: `mcp_servers.<name>`, its `tool_timeout_sec`, and `omit_tools_from`, without
 *   `"deferred"` in which the model reaches the server's tools only through a tool search first
 * - failures: `codex-rs/protocol/src/error.rs`, whose words for a status are
 *   `unexpected status 401 Unauthorized: …` or `exceeded retry limit, last status: 429 …`, followed
 *   by the provider's own body, which can repeat part of the key
 * - the sandbox's certificate: `codex-rs/http-client/src/custom_ca.rs` (`SSL_CERT_FILE`)
 */
import { type AgentSnapshot, MODEL_PROVIDER_NAMES } from "@gateweave/agents-model";
import { z } from "zod";
import { ENGINE_TOOLS_SERVER, ENGINE_TOOLS_URL } from "./engine-tools";
import {
	byteSize,
	type ChunkSink,
	clip,
	contentText,
	ENGINE_SECONDS,
	type EngineCommand,
	type EngineJob,
	type EngineMemory,
	type EngineOutcome,
	type EngineTurn,
	enginePrompt,
	failed,
	MAX_CHAT_OUTPUT,
	outputOf,
} from "./engines";
import type { RunRecorder } from "./trace";

/** The server the trace and the chat name for Codex's own tools. */
export const CODEX_SERVER = "codex";

/** What the CLI sends as its key, which `SandboxOutbound` replaces with the workspace's. */
export const CODEX_PLACEHOLDER_KEY = "sk-gateweave-sandbox-placeholder";

/** The variable the CLI reads its key from, by Gateweave's provider's `env_key`. */
const KEY_VARIABLE = "GATEWEAVE_OPENAI_KEY";

/**
 * Where Codex keeps its sessions, under its home: its default, `~/.codex`, which it creates. It
 * refuses to start with a `CODEX_HOME` that does not exist yet, as in a new container.
 */
export const CODEX_SESSIONS = "/root/.codex/sessions";

/** Where its own messages go in the sandbox, out of the events' way. */
export const CODEX_LOG = "/tmp/codex.log";

/** What the CLI runs with besides the sandbox's usual environment. */
export const CODEX_ENV: Record<string, string> = {
	[KEY_VARIABLE]: CODEX_PLACEHOLDER_KEY,
};

/** How long Gateweave's tools server has to answer the CLI's first requests. */
const TOOLS_STARTUP_SECONDS = 60;

/** A string as TOML writes it: JSON's escapes are TOML's, but for DEL and lone surrogates. */
export function tomlString(text: string): string {
	return JSON.stringify(text.toWellFormed()).replaceAll("\u007f", "\\u007F");
}

/**
 * The settings the turn runs with, as `-c` takes them. Its requests go to OpenAI over HTTPS, the
 * only way out of the sandbox, with the key from `KEY_VARIABLE`. Nothing else it would send gets
 * out, so it sends none: no update checks, analytics or feedback, and no web search.
 */
export function codexConfig(options: { system: string; tools: boolean }): string[] {
	return [
		'model_provider="gateweave"',
		`model_providers.gateweave={name="OpenAI",base_url="https://api.openai.com/v1",env_key="${KEY_VARIABLE}",wire_api="responses",supports_websockets=false}`,
		"check_for_update_on_startup=false",
		"analytics.enabled=false",
		"feedback.enabled=false",
		'web_search="disabled"',
		...(options.system === "" ? [] : [`developer_instructions=${tomlString(options.system)}`]),
		// The tools come in the model's first request, as in Gateweave's loop. A delegated task can
		// take as long as the turn may.
		...(options.tools
			? [
					`mcp_servers.${ENGINE_TOOLS_SERVER}={url="${ENGINE_TOOLS_URL}",startup_timeout_sec=${TOOLS_STARTUP_SECONDS},tool_timeout_sec=${ENGINE_SECONDS},omit_tools_from=["deferred"]}`,
				]
			: []),
	];
}

/**
 * The command line after `codex`, for a thread to start or to resume, with Gateweave's tools or
 * without. The sandbox is the turn's sandbox, so Codex asks nothing and runs without its own.
 * `--ignore-user-config` leaves out a `config.toml` in its home: the settings are these alone.
 */
export function codexArguments(options: {
	model: string;
	system: string;
	resume: boolean;
	tools: boolean;
}): string[] {
	return [
		"exec",
		// The container holds this conversation's thread alone, wherever it worked.
		...(options.resume ? ["resume", "--last", "--all"] : []),
		"--json",
		"--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox",
		"--ignore-user-config",
		"--model",
		options.model,
		...codexConfig(options).flatMap((setting) => ["-c", setting]),
		// The message comes on its input.
		"-",
	];
}

/** How the sandbox runs a turn of Codex: resuming its thread when the sandbox still has one. */
export function codexCommand(job: EngineJob, resume: boolean): EngineCommand {
	const tools = job.access.tools !== null;
	return {
		argv: ["codex", ...codexArguments({ model: job.model, system: job.system, resume, tools })],
		env: CODEX_ENV,
		input: enginePrompt(job, resume),
		log: CODEX_LOG,
	};
}

/** The longest failure of a tool the trace records. */
const TRACE_ERROR_LIMIT = 500;

/** The longest part of Codex's own words a failure it has no name for quotes. */
const FAILURE_DETAIL_LIMIT = 300;

/** Where a thread's usage so far is kept between turns, in the conversation's storage. */
const USAGE_KEY = "codex-usage";

const usageSchema = z.object({
	input_tokens: z.number(),
	cached_input_tokens: z.number(),
	cache_write_input_tokens: z.number().optional(),
	output_tokens: z.number(),
});

type Usage = z.infer<typeof usageSchema>;

/** A thread's usage after its last turn that completed. */
interface ThreadUsage {
	thread: string;
	usage: Usage;
}

const threadStarted = z.object({ type: z.literal("thread.started"), thread_id: z.string() });
const turnCompleted = z.object({ type: z.literal("turn.completed"), usage: usageSchema });
const turnFailed = z.object({
	type: z.literal("turn.failed"),
	error: z.object({ message: z.string() }),
});
const errorEvent = z.object({ type: z.literal("error"), message: z.string() });
const itemEvent = z.object({
	type: z.enum(["item.started", "item.updated", "item.completed"]),
	item: z.object({ id: z.string() }).loose(),
});

const agentMessage = z.object({ type: z.literal("agent_message"), text: z.string() });
const commandExecution = z.object({
	type: z.literal("command_execution"),
	command: z.string(),
	aggregated_output: z.string(),
	exit_code: z.number().nullish(),
	status: z.string(),
});
const fileChange = z.object({
	type: z.literal("file_change"),
	changes: z.array(z.object({ path: z.string(), kind: z.string() })),
	status: z.string(),
});
const mcpToolCall = z.object({
	type: z.literal("mcp_tool_call"),
	server: z.string(),
	tool: z.string(),
	arguments: z.unknown(),
	result: z.object({ content: z.array(z.unknown()) }).nullish(),
	error: z.object({ message: z.string() }).nullish(),
	status: z.string(),
});
const errorItem = z.object({ type: z.literal("error"), message: z.string() });

/** A tool call under way: its span, none for Gateweave's own tools, which record theirs. */
interface ToolCall {
	span: string | null;
	gateweave: boolean;
}

/**
 * Follows one turn of Codex, an event at a time. Its text and tool calls go to the chat, and its
 * usage, its commands, patches and MCP calls to the trace.
 */
export class CodexTurn implements EngineTurn {
	readonly #sink: ChunkSink;
	readonly #run: RunRecorder;
	readonly #agent: AgentSnapshot;
	readonly #memory: EngineMemory;
	readonly #tools = new Map<string, ToolCall>();
	#thread: string | null = null;
	/** Whether the turn's model span and the chat's step are open. */
	#open = false;
	#completed = false;
	/** Why the turn failed, in Codex's words. */
	#failure: string | null = null;
	/** What Codex last said of an error it went on from, which a failure it has no words for quotes. */
	#detail: string | null = null;

	/** `memory` keeps the thread's usage so far, which each turn's own usage is counted from. */
	constructor(sink: ChunkSink, run: RunRecorder, agent: AgentSnapshot, memory: EngineMemory) {
		this.#sink = sink;
		this.#run = run;
		this.#agent = agent;
		this.#memory = memory;
	}

	/** Takes one line of Codex's output. Anything not an event it knows is left alone. */
	take(line: string, now = Date.now()): void {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const item = itemEvent.safeParse(event);
		if (item.success) {
			if (item.data.type === "item.started") this.#started(item.data.item, now);
			if (item.data.type === "item.completed") this.#completedItem(item.data.item, now);
			return;
		}
		const type = typeof event === "object" && event !== null && "type" in event ? event.type : null;
		if (type === "turn.started") {
			this.#open = true;
			this.#run.stepStarted(0, now);
			this.#sink.write({ type: "start-step" });
			return;
		}
		const completed = turnCompleted.safeParse(event);
		if (completed.success) {
			this.#completed = true;
			this.#endModel(this.#turnUsage(completed.data.usage), "stop", now);
			return;
		}
		const failure = turnFailed.safeParse(event);
		if (failure.success) {
			this.#failure = failure.data.error.message;
			this.#endModel(null, "error", now);
			return;
		}
		const thread = threadStarted.safeParse(event);
		if (thread.success) {
			this.#thread = thread.data.thread_id;
			return;
		}
		// One it went on from, such as a reconnection; a fatal one is the turn's failure.
		const error = errorEvent.safeParse(event);
		if (error.success) this.#detail = error.data.message;
	}

	/** Ends what is still open and says how the turn went. */
	end(now = Date.now()): EngineOutcome {
		this.#endModel(null, "error", now);
		if (this.#completed) return { status: "succeeded" };
		return failed(describeFailure(this.#agent, this.#failure, this.#detail));
	}

	#started(item: { id: string }, now: number): void {
		const command = commandExecution.safeParse(item);
		if (command.success) {
			this.#toolStarted(item.id, "shell", { command: command.data.command }, now);
			return;
		}
		const call = mcpToolCall.safeParse(item);
		if (call.success) this.#mcpStarted(item.id, call.data, now);
	}

	#completedItem(item: { id: string }, now: number): void {
		const message = agentMessage.safeParse(item);
		if (message.success) {
			if (message.data.text === "") return;
			const id = crypto.randomUUID();
			this.#sink.write({ type: "text-start", id });
			this.#sink.write({ type: "text-delta", id, delta: message.data.text });
			this.#sink.write({ type: "text-end", id });
			return;
		}
		const command = commandExecution.safeParse(item);
		if (command.success) {
			const { aggregated_output: output, exit_code: code, status } = command.data;
			if (!this.#tools.has(item.id)) {
				this.#toolStarted(item.id, "shell", { command: command.data.command }, now);
			}
			if (status === "completed") {
				this.#toolEnded(item.id, { text: output }, null, now);
			} else {
				const why =
					status === "declined" ? "The command was declined." : `Exit code ${code ?? "unknown"}`;
				this.#toolEnded(item.id, null, output === "" ? why : `${why}\n${output}`, now);
			}
			return;
		}
		const patch = fileChange.safeParse(item);
		if (patch.success) {
			// A patch comes once, when it has applied or failed.
			const { changes, status } = patch.data;
			this.#toolStarted(item.id, "apply_patch", { changes }, now);
			const files = changes.map((change) => `${change.kind} ${change.path}`).join("\n");
			if (status === "completed") this.#toolEnded(item.id, { text: files }, null, now);
			else this.#toolEnded(item.id, null, `The patch did not apply.\n${files}`, now);
			return;
		}
		const call = mcpToolCall.safeParse(item);
		if (call.success) {
			if (!this.#tools.has(item.id)) this.#mcpStarted(item.id, call.data, now);
			const text = contentText(call.data.result?.content ?? []);
			if (call.data.status === "completed" && !call.data.error) {
				this.#toolEnded(item.id, { text }, null, now);
			} else {
				this.#toolEnded(item.id, null, call.data.error?.message || text || "The tool failed.", now);
			}
			return;
		}
		const error = errorItem.safeParse(item);
		if (error.success) this.#detail = error.data.message;
	}

	#mcpStarted(id: string, call: z.infer<typeof mcpToolCall>, now: number): void {
		if (call.server === ENGINE_TOOLS_SERVER) {
			// Gateweave's tools go by their own names, so the chat shows them as it does in
			// Gateweave's loop: a pull request as its link, an edge as the member it reached.
			this.#tools.set(id, { span: null, gateweave: true });
			this.#sink.write({
				type: "tool-input-available",
				toolCallId: id,
				toolName: call.tool,
				input: call.arguments,
				dynamic: true,
			});
			return;
		}
		this.#toolStarted(id, `mcp__${call.server}__${call.tool}`, call.arguments, now);
	}

	#toolStarted(id: string, name: string, input: unknown, now: number): void {
		const span = this.#run.toolStarted(CODEX_SERVER, name, byteSize(input), now);
		this.#tools.set(id, { span, gateweave: false });
		this.#sink.write({
			type: "tool-input-available",
			toolCallId: id,
			toolName: `${CODEX_SERVER}__${name}`,
			input,
			dynamic: true,
		});
	}

	/** Ends a call with its output, or with `error`. */
	#toolEnded(id: string, output: { text: string } | null, error: string | null, now: number): void {
		const call = this.#tools.get(id);
		if (!call) return;
		this.#tools.delete(id);
		if (call.span !== null && error !== null) {
			this.#run.toolEnded(call.span, { error: clip(error, TRACE_ERROR_LIMIT) }, now);
		} else if (call.span !== null) {
			this.#run.toolEnded(
				call.span,
				{ outputBytes: byteSize(output?.text ?? ""), error: null },
				now,
			);
		}
		if (error !== null) {
			this.#sink.write({
				type: "tool-output-error",
				toolCallId: id,
				errorText: clip(error, MAX_CHAT_OUTPUT),
				dynamic: true,
			});
			return;
		}
		const text = output?.text ?? "";
		this.#sink.write({
			type: "tool-output-available",
			toolCallId: id,
			output: (call.gateweave && outputOf(text)) || { text: clip(text, MAX_CHAT_OUTPUT) },
			dynamic: true,
		});
	}

	/**
	 * The turn's own usage: the thread's so far, less what it was after its last turn that
	 * completed. A thread the sandbox no longer has starts over. A turn that failed reports no
	 * usage, so what it used counts with the next one that completes.
	 */
	#turnUsage(total: Usage): Usage {
		const kept = this.#memory.get<ThreadUsage>(USAGE_KEY);
		const before = kept && kept.thread === this.#thread ? kept.usage : null;
		if (this.#thread !== null)
			this.#memory.put<ThreadUsage>(USAGE_KEY, { thread: this.#thread, usage: total });
		const less = (field: keyof Usage) => Math.max(0, (total[field] ?? 0) - (before?.[field] ?? 0));
		return {
			input_tokens: less("input_tokens"),
			cached_input_tokens: less("cached_input_tokens"),
			cache_write_input_tokens: less("cache_write_input_tokens"),
			output_tokens: less("output_tokens"),
		};
	}

	/** Ends the turn's model span and the chat's step, if they are open. */
	#endModel(usage: Usage | null, finishReason: "stop" | "error", now: number): void {
		if (!this.#open) return;
		this.#open = false;
		this.#run.requestEnded(
			0,
			{
				model: this.#agent.model,
				// OpenAI counts cached input in the input, as the trace does.
				tokens: {
					input: usage?.input_tokens ?? 0,
					output: usage?.output_tokens ?? 0,
					cacheRead: usage?.cached_input_tokens ?? 0,
					cacheWrite: usage?.cache_write_input_tokens ?? 0,
				},
				finishReason,
				firstTokenMs: null,
				gatewayLogId: null,
				summed: true,
			},
			now,
		);
		this.#sink.write({ type: "finish-step" });
	}
}

/** A status in Codex's words for a request that failed. */
const STATUS = /(?:unexpected status|last status:) (\d{3})\b/;

/**
 * Why Codex's turn failed, in the same words as a turn of Gateweave's own loop. What it says
 * otherwise is quoted with anything like a key taken out: OpenAI's errors repeat part of the key.
 */
function describeFailure(
	agent: AgentSnapshot,
	failure: string | null,
	detail: string | null,
): string {
	const name = MODEL_PROVIDER_NAMES[agent.provider];
	const words = failure ?? detail;
	if (words === null) return "Codex stopped before it finished.";
	const status = Number(STATUS.exec(words)?.[1] ?? 0);
	if (status === 401 || status === 403) {
		return `${name} refused the workspace's key. An owner or admin can check it in Settings.`;
	}
	if (status === 404) return `${name} has no model ${agent.model} for the workspace's key.`;
	if (words.startsWith("Quota exceeded")) {
		return `${name} refused the workspace's key for its billing. An owner can check the account.`;
	}
	if (status === 429 || words.startsWith("rate limit exceeded")) {
		return `${name} is limiting the workspace's requests. Try again shortly.`;
	}
	if (status >= 500 || words.startsWith("Selected model is at capacity")) {
		return `${name} could not answer just now. Try again shortly.`;
	}
	const said = failure === null ? "Codex stopped before it finished" : "Codex could not finish";
	return `${said}: ${clip(withoutKeys(words), FAILURE_DETAIL_LIMIT)}`;
}

/** Text with anything that looks like a key, whole or masked, taken out. */
export function withoutKeys(text: string): string {
	return text.replace(/\bsk-[\w*.-]+/g, "[key]").replace(/\S*\*{3,}\S*/g, "[key]");
}
