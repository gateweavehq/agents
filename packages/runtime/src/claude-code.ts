/**
 * Claude Code as an agent's engine (AGT-44). A turn of an agent whose engine is `claude-code` runs
 * Anthropic's Claude Code CLI in the conversation's sandbox, in place of Gateweave's own loop. It
 * reads the repository's CLAUDE.md, skills and settings as it would on a laptop, works with its own
 * tools, and the turn passes on what it does as its events come: its text and tool calls to the
 * chat, and each model request and tool call to the run's trace.
 *
 * The CLI holds no key. It sends a placeholder, and `SandboxOutbound` puts the workspace's
 * Anthropic key on its requests to Anthropic on the way out, while the turn runs (`./outbound.ts`).
 * One conversation is one Claude Code session, which each turn resumes while the sandbox has it.
 *
 * The turn's other tools, its MCP servers, `open_pull_request` and a team's edges, reach the CLI
 * as one MCP server, `gateweave`, which the conversation answers (`./claude-code-tools.ts`). Their
 * calls come to the chat under their own names, and record their own spans, as in Gateweave's loop.
 *
 * Checked 2026-10-29:
 * - headless runs and their flags: https://code.claude.com/docs/en/headless
 * - permission modes, and why not `bypassPermissions` (it refuses to run as root, as the sandbox's
 *   commands do): https://code.claude.com/docs/en/permission-modes
 * - the events' shapes: `SDKMessage` in `sdk.d.ts` of @anthropic-ai/claude-agent-sdk 0.3.312
 * - which usage each event carries: Claude Code 2.1.308 against a fake Anthropic API. An
 *   `assistant` event has the usage of the request's start, a `stream_event` with `message_delta`
 *   its final usage (`--include-partial-messages`), and `result` the turn's totals
 */
import {
	type AgentSnapshot,
	MODEL_PROVIDER_NAMES,
	PULL_REQUEST_TOOL,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";
import {
	CLAUDE_CODE_TOOL_PREFIX,
	CLAUDE_CODE_TOOLS_SERVER,
	type ClaudeCodeToolsAccess,
	claudeCodeMcpConfig,
} from "./claude-code-tools";
import type { GatewayMetadata } from "./models";
import type { RunRecorder } from "./trace";

/** The server the trace and the chat name for Claude Code's own tools. */
export const CLAUDE_CODE_SERVER = "claude-code";

/** What the CLI sends as its key, which `SandboxOutbound` replaces with the workspace's. */
export const CLAUDE_CODE_PLACEHOLDER_KEY = "sk-ant-gateweave-sandbox-placeholder";

/** The agentic turns one message may take, each a model request and the tools it calls. */
export const CLAUDE_CODE_TURNS = 100;

/** How long one turn may run before the sandbox stops it. */
export const CLAUDE_CODE_SECONDS = 60 * 60;

/**
 * The tools that would otherwise ask for a person's approval, which nobody is there to give.
 * Reading and searching need none. The web tools stay off: the sandbox reaches no website anyway.
 */
const ALLOWED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Skill", "Monitor"];

/** Where the CLI's own messages go in the sandbox, out of the events' way. */
export const CLAUDE_CODE_LOG = "/tmp/claude-code.log";

/**
 * What the CLI runs with besides the sandbox's usual environment. Nothing it would send besides
 * its requests to the model gets out of the sandbox, so it sends none: no updates, telemetry or
 * error reports. Background tasks are off, so a turn ends when its last answer does, and so is
 * moving a slow call of Gateweave's tools to the background, so a delegated task is waited for.
 */
export const CLAUDE_CODE_ENV: Record<string, string> = {
	ANTHROPIC_API_KEY: CLAUDE_CODE_PLACEHOLDER_KEY,
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	DISABLE_AUTOUPDATER: "1",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
	CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
};

/**
 * What the turn's requests out of the sandbox go with: the workspace's key and what AI Gateway
 * logs about its requests to Anthropic, and the way to Gateweave's tools, if the turn has any.
 */
export interface ClaudeCodeAccess {
	key: string;
	metadata: GatewayMetadata;
	tools: ClaudeCodeToolsAccess | null;
}

/** A turn for Claude Code, as the conversation hands it to its sandbox. */
export interface ClaudeCodeJob {
	/** The person's message. */
	prompt: string;
	/** The conversation so far, for a sandbox that no longer has its session; null for none. */
	history: string | null;
	/** What Claude Code reads after its own system prompt. */
	system: string;
	model: string;
	/** Where it works: the repository's checkout, or the sandbox's root. */
	cwd: string;
	access: ClaudeCodeAccess;
}

/** What a conversation reaches of its sandbox to run Claude Code. */
export interface ClaudeCodePort {
	/** Starts the turn. Its events, one JSON object a line, as Claude Code writes them. */
	startClaudeCode(job: ClaudeCodeJob): Promise<ReadableStream<Uint8Array>>;
	/** Ends the turn under way: Claude Code finishes it as it would on Ctrl+C, or is killed. */
	stopClaudeCode(): Promise<void>;
}

/**
 * The command line after `claude`, for a session to start or to resume, with Gateweave's tools or
 * without. Only those: the repository's own MCP servers would reach nothing from the sandbox.
 */
export function claudeCodeArguments(options: {
	model: string;
	system: string;
	session: string;
	resume: boolean;
	tools: boolean;
}): string[] {
	const allowed = options.tools
		? [...ALLOWED_TOOLS, `mcp__${CLAUDE_CODE_TOOLS_SERVER}`]
		: ALLOWED_TOOLS;
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		// The only events with a request's final usage: an `assistant` event has its start's.
		"--include-partial-messages",
		"--model",
		options.model,
		"--permission-mode",
		"dontAsk",
		"--permission-prompts",
		"none",
		"--allowedTools",
		allowed.join(","),
		"--max-turns",
		String(CLAUDE_CODE_TURNS),
		"--strict-mcp-config",
		...(options.tools ? ["--mcp-config", claudeCodeMcpConfig(CLAUDE_CODE_SECONDS * 1000)] : []),
		...(options.system === "" ? [] : ["--append-system-prompt", options.system]),
		...(options.resume ? ["--resume", options.session] : ["--session-id", options.session]),
	];
}

/** What Claude Code reads first: the message, after the conversation so far when it lost that. */
export function claudeCodePrompt(job: ClaudeCodeJob, resumed: boolean): string {
	if (resumed || job.history === null) return job.prompt;
	return [
		"This conversation began in a sandbox that has stopped since, so you do not have it. What was said so far:",
		job.history,
		"The person's new message:",
		job.prompt,
	].join("\n\n");
}

/** Most characters of the conversation so far that a new session reads. */
export const MAX_HISTORY = 50_000;

/**
 * The conversation before its last message, as text, for a session that starts over: what the
 * person said and what the agent answered, the most recent kept when it is long. Null when the
 * last message is the first.
 */
export function historyOf(messages: UIMessage[], name: string): string | null {
	const earlier = messages.slice(
		0,
		messages.findLastIndex((message) => message.role === "user"),
	);
	const said = earlier.flatMap((message) => {
		const text = message.parts
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n\n")
			.trim();
		if (text === "") return [];
		return [`${message.role === "user" ? "The person" : name}: ${text}`];
	});
	if (said.length === 0) return null;
	const text = said.join("\n\n");
	return text.length <= MAX_HISTORY ? text : `[…]\n${text.slice(-MAX_HISTORY)}`;
}

/**
 * What Claude Code is told of where it runs, after the agent's instructions. With `pullRequests`,
 * it proposes its work with Gateweave's `open_pull_request`; without, it says what it changed.
 */
export function claudeCodeNote(
	repository: SandboxRepository | null,
	branch: string,
	pullRequests: boolean,
): string {
	const sandbox =
		"You run in a Linux sandbox that reaches no website: package registries such as npm and PyPI work, the rest of the internet does not.";
	if (!repository) return sandbox;
	const name = `${repository.owner}/${repository.name}`;
	return [
		sandbox,
		`The repository ${name} is checked out at ${SANDBOX_REPOSITORY_PATH}, on the branch ${branch}, made from ${repository.defaultBranch}.`,
		pullRequests
			? `git push does not work from the sandbox. To propose your work, call ${PULL_REQUEST_TOOL} (a tool of the ${CLAUDE_CODE_TOOLS_SERVER} MCP server): it commits what you changed in the checkout and opens a pull request, or updates the one the branch has.`
			: "git push does not work from the sandbox. Leave your work in the checkout and say in your answer what you changed.",
	].join(" ");
}

/** Splits a stream into its lines, skipping empty ones and any longer than `MAX_LINE`. */
export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// Inside a line too long to keep, until it ends.
	let skipping = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let end = buffer.indexOf("\n");
		while (end !== -1) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (!skipping && line.trim() !== "") yield line;
			skipping = false;
			end = buffer.indexOf("\n");
		}
		if (buffer.length > MAX_LINE) {
			buffer = "";
			skipping = true;
		}
	}
	buffer += decoder.decode();
	if (!skipping && buffer.trim() !== "") yield buffer;
}

/** The longest event kept: a tool's result can be a whole file, which the trace needs no more of. */
export const MAX_LINE = 8_000_000;

/** Most characters of a tool's result the chat keeps: Claude Code has the whole of it. */
export const MAX_CHAT_OUTPUT = 4_000;

/** The longest failure of a tool the trace records. */
const TRACE_ERROR_LIMIT = 500;

/**
 * The model Claude Code names on a message it writes itself, such as why a request failed. Its text
 * is meant for a terminal ("Invalid API key · Fix external API key"), and no request made it.
 */
const SYNTHETIC_MODEL = "<synthetic>";

/** The longest part of Claude Code's own words a failure it has no name for quotes. */
const FAILURE_DETAIL_LIMIT = 300;

const usageSchema = z.object({
	input_tokens: z.number().optional(),
	output_tokens: z.number().optional(),
	cache_creation_input_tokens: z.number().nullish(),
	cache_read_input_tokens: z.number().nullish(),
});

type Usage = z.infer<typeof usageSchema>;

const assistantEvent = z.object({
	type: z.literal("assistant"),
	parent_tool_use_id: z.string().nullish(),
	error: z.string().optional(),
	message: z.object({
		id: z.string(),
		model: z.string().optional(),
		content: z.array(z.unknown()),
		usage: usageSchema.nullish(),
	}),
});

const userEvent = z.object({
	type: z.literal("user"),
	parent_tool_use_id: z.string().nullish(),
	message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

/**
 * One of the API's own streaming events, as `--include-partial-messages` passes them on. Two
 * matter: a request's start, with its id and how long its first token took, and its final usage,
 * which names no request and comes after its blocks. The blocks the `assistant` events carry whole.
 */
const streamEvent = z.object({
	type: z.literal("stream_event"),
	parent_tool_use_id: z.string().nullish(),
	ttft_ms: z.number().optional(),
	event: z.object({
		type: z.string(),
		message: z.object({ id: z.string() }).optional(),
		usage: usageSchema.nullish(),
	}),
});

const resultEvent = z.object({
	type: z.literal("result"),
	subtype: z.string(),
	is_error: z.boolean(),
	num_turns: z.number().optional(),
});

const textBlock = z.object({ type: z.literal("text"), text: z.string() });

const toolUseBlock = z.object({
	type: z.literal("tool_use"),
	id: z.string(),
	name: z.string(),
	input: z.unknown(),
});

const toolResultBlock = z.object({
	type: z.literal("tool_result"),
	tool_use_id: z.string(),
	is_error: z.boolean().optional(),
	content: z.unknown(),
});

/** Where a turn's chat chunks go: the stream the conversation answers with. */
export interface ChunkSink {
	write(chunk: UIMessageChunk): void;
}

/** How a turn of Claude Code went. */
export type ClaudeCodeOutcome = { status: "succeeded" } | { status: "failed"; error: string };

/** A model request of the turn, which Claude Code sends block by block, with the usage so far. */
interface Request {
	step: number;
	/** The tool call of a subagent it belongs to; null in the main conversation. */
	parent: string | null;
	model: string;
	usage: Usage;
	toolCalls: boolean;
	startedAt: number;
	firstTokenMs: number | null;
}

/**
 * A tool call under way: its span, and whether the chat shows it. A call of Gateweave's own tools
 * has no span here: the conversation records it as it runs the tool, as in Gateweave's loop.
 */
interface ToolCall {
	span: string | null;
	shown: boolean;
	gateweave: boolean;
}

/**
 * Follows one turn of Claude Code, an event at a time. The main conversation's text and tool calls
 * go to the chat, a subagent's only to the trace, which records every model request and tool call.
 */
export class ClaudeCodeTurn {
	readonly #sink: ChunkSink;
	readonly #run: RunRecorder;
	readonly #agent: AgentSnapshot;
	readonly #requests = new Map<string, Request>();
	readonly #tools = new Map<string, ToolCall>();
	#steps = 0;
	/** Whether the chat has a step open, from the main conversation's request it shows. */
	#stepOpen = false;
	#result: z.infer<typeof resultEvent> | null = null;
	/** Why a model request failed, as Claude Code names it. */
	#apiError: string | null = null;
	/** What Claude Code last said itself, which a failure it has no name for quotes. */
	#detail: string | null = null;
	/**
	 * The request each conversation is streaming, by its subagent's tool call ("" for the main
	 * one), with how long its first token took. A conversation's requests come one at a time.
	 */
	readonly #streaming = new Map<string, { id: string; firstTokenMs: number | null }>();

	constructor(sink: ChunkSink, run: RunRecorder, agent: AgentSnapshot) {
		this.#sink = sink;
		this.#run = run;
		this.#agent = agent;
	}

	/** Takes one line of Claude Code's output. Anything not an event it knows is left alone. */
	take(line: string, now = Date.now()): void {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		// Most lines are streaming events, a block's text a piece at a time: their type says so first.
		const type = typeof event === "object" && event !== null && "type" in event ? event.type : null;
		if (type === "stream_event") {
			const stream = streamEvent.safeParse(event);
			if (stream.success) this.#stream(stream.data);
			return;
		}
		const assistant = assistantEvent.safeParse(event);
		if (assistant.success) {
			this.#assistant(assistant.data, now);
			return;
		}
		const user = userEvent.safeParse(event);
		if (user.success) {
			this.#user(user.data, now);
			return;
		}
		const result = resultEvent.safeParse(event);
		if (result.success) {
			this.#result = result.data;
			this.#endRequests(null, now);
		}
	}

	/** Ends what is still open and says how the turn went. */
	end(now = Date.now()): ClaudeCodeOutcome {
		this.#endRequests(undefined, now);
		this.#closeStep();
		const result = this.#result;
		if (!result) return failed("Claude Code stopped before it finished.");
		if (result.subtype === "error_max_turns") {
			return failed(
				`Claude Code stopped after ${result.num_turns ?? CLAUDE_CODE_TURNS} turns, the most one message may take.`,
			);
		}
		if (result.subtype !== "success" || result.is_error) {
			return failed(describeApiError(this.#agent, this.#apiError, this.#detail));
		}
		return { status: "succeeded" };
	}

	#stream({
		parent_tool_use_id: parent,
		ttft_ms: firstToken,
		event,
	}: z.infer<typeof streamEvent>): void {
		const conversation = parent ?? "";
		if (event.type === "message_start" && event.message) {
			const firstTokenMs = firstToken === undefined ? null : Math.round(firstToken);
			this.#streaming.set(conversation, { id: event.message.id, firstTokenMs });
			return;
		}
		if (event.type !== "message_delta" || !event.usage) return;
		const id = this.#streaming.get(conversation)?.id;
		const request = id === undefined ? undefined : this.#requests.get(id);
		if (request) request.usage = latestUsage(request.usage, event.usage);
	}

	#assistant(event: z.infer<typeof assistantEvent>, now: number): void {
		const { message } = event;
		const parent = event.parent_tool_use_id ?? null;
		if (event.error && event.error !== "max_output_tokens") this.#apiError = event.error;
		if (message.model === SYNTHETIC_MODEL) {
			// Neither the model's answer nor a request: the turn's outcome says what went wrong.
			const text = message.content.flatMap((content) => {
				const block = textBlock.safeParse(content);
				return block.success ? [block.data.text] : [];
			});
			this.#detail = text.join("\n").trim() || this.#detail;
			return;
		}
		let request = this.#requests.get(message.id);
		if (!request) {
			// A new request means the one before it in the same conversation has answered.
			this.#endRequests(parent, now);
			const streaming = this.#streaming.get(parent ?? "");
			request = {
				step: this.#steps++,
				parent,
				model: message.model ?? this.#agent.model,
				usage: {},
				toolCalls: false,
				startedAt: now,
				firstTokenMs: streaming?.id === message.id ? streaming.firstTokenMs : null,
			};
			this.#requests.set(message.id, request);
			this.#run.stepStarted(request.step, now);
			if (parent === null) {
				this.#closeStep();
				this.#sink.write({ type: "start-step" });
				this.#stepOpen = true;
			}
		}
		if (message.usage) request.usage = latestUsage(request.usage, message.usage);
		for (const content of message.content) {
			const text = textBlock.safeParse(content);
			if (text.success && parent === null && text.data.text !== "") {
				const id = crypto.randomUUID();
				this.#sink.write({ type: "text-start", id });
				this.#sink.write({ type: "text-delta", id, delta: text.data.text });
				this.#sink.write({ type: "text-end", id });
				continue;
			}
			const call = toolUseBlock.safeParse(content);
			if (!call.success || this.#tools.has(call.data.id)) continue;
			request.toolCalls = true;
			const { name } = call.data;
			const gateweave = name.startsWith(CLAUDE_CODE_TOOL_PREFIX);
			const span = gateweave
				? null
				: this.#run.toolStarted(CLAUDE_CODE_SERVER, name, byteSize(call.data.input), now);
			this.#tools.set(call.data.id, { span, shown: parent === null, gateweave });
			if (parent === null) {
				this.#sink.write({
					type: "tool-input-available",
					toolCallId: call.data.id,
					// Gateweave's tools go by their own names, so the chat shows them as it does in
					// Gateweave's loop: a pull request as its link, an edge as the member it reached.
					toolName: gateweave
						? name.slice(CLAUDE_CODE_TOOL_PREFIX.length)
						: `${CLAUDE_CODE_SERVER}__${name}`,
					input: call.data.input,
					dynamic: true,
				});
			}
		}
	}

	#user(event: z.infer<typeof userEvent>, now: number): void {
		const { content } = event.message;
		if (typeof content === "string") return;
		for (const block of content) {
			const result = toolResultBlock.safeParse(block);
			if (!result.success) continue;
			const call = this.#tools.get(result.data.tool_use_id);
			if (!call) continue;
			this.#tools.delete(result.data.tool_use_id);
			const text = resultText(result.data.content);
			if (call.span !== null && result.data.is_error) {
				this.#run.toolEnded(call.span, { error: clip(text, TRACE_ERROR_LIMIT) }, now);
			} else if (call.span !== null) {
				this.#run.toolEnded(call.span, { outputBytes: byteSize(text), error: null }, now);
			}
			if (!call.shown) continue;
			if (result.data.is_error) {
				this.#sink.write({
					type: "tool-output-error",
					toolCallId: result.data.tool_use_id,
					errorText: clip(text, MAX_CHAT_OUTPUT),
					dynamic: true,
				});
			} else {
				this.#sink.write({
					type: "tool-output-available",
					toolCallId: result.data.tool_use_id,
					output: (call.gateweave && outputOf(text)) || { text: clip(text, MAX_CHAT_OUTPUT) },
					dynamic: true,
				});
			}
		}
	}

	/**
	 * Ends the requests still open: those of the conversation `parent` names (null is the main
	 * one), or all of them when it is undefined.
	 */
	#endRequests(parent: string | null | undefined, now: number): void {
		for (const [id, request] of this.#requests) {
			if (parent !== undefined && request.parent !== parent) continue;
			this.#requests.delete(id);
			const { usage } = request;
			const cacheRead = usage.cache_read_input_tokens ?? 0;
			const cacheWrite = usage.cache_creation_input_tokens ?? 0;
			this.#run.requestEnded(
				request.step,
				{
					model: request.model,
					// Anthropic counts cached input apart; the trace counts it in the input too.
					tokens: {
						input: (usage.input_tokens ?? 0) + cacheRead + cacheWrite,
						output: usage.output_tokens ?? 0,
						cacheRead,
						cacheWrite,
					},
					finishReason: request.toolCalls ? "tool-calls" : "stop",
					firstTokenMs: request.firstTokenMs,
					gatewayLogId: null,
				},
				now,
			);
		}
	}

	#closeStep(): void {
		if (!this.#stepOpen) return;
		this.#sink.write({ type: "finish-step" });
		this.#stepOpen = false;
	}
}

/**
 * A request's usage as far as it is known: each count only grows while it runs, and the events
 * that carry them need not come in order.
 */
function latestUsage(known: Usage, next: Usage): Usage {
	const most = (a: number | null | undefined, b: number | null | undefined) =>
		a == null ? (b ?? undefined) : b == null ? a : Math.max(a, b);
	return {
		input_tokens: most(known.input_tokens, next.input_tokens),
		output_tokens: most(known.output_tokens, next.output_tokens),
		cache_creation_input_tokens: most(
			known.cache_creation_input_tokens,
			next.cache_creation_input_tokens,
		),
		cache_read_input_tokens: most(known.cache_read_input_tokens, next.cache_read_input_tokens),
	};
}

/** Why Claude Code's turn failed, in the same words as a turn of Gateweave's own loop. */
function describeApiError(
	agent: AgentSnapshot,
	error: string | null,
	detail: string | null,
): string {
	const name = MODEL_PROVIDER_NAMES[agent.provider];
	switch (error) {
		case "authentication_failed":
			return `${name} refused the workspace's key. An owner or admin can check it in Settings.`;
		case "billing_error":
			return `${name} refused the workspace's key for its billing. An owner can check the account.`;
		case "rate_limit":
			return `${name} is limiting the workspace's requests. Try again shortly.`;
		case "model_not_found":
			return `${name} has no model ${agent.model} for the workspace's key.`;
		case "overloaded":
		case "server_error":
			return `${name} could not answer just now. Try again shortly.`;
		default:
			return detail
				? `Claude Code could not finish: ${clip(detail, FAILURE_DETAIL_LIMIT)}`
				: "Claude Code could not finish.";
	}
}

/**
 * The output of one of Gateweave's tools, which its server sent as JSON text, as the chat shows it
 * in Gateweave's loop; null for text that is not a JSON object, or too long for the chat.
 */
function outputOf(text: string): object | null {
	if (text.length > MAX_CHAT_OUTPUT) return null;
	try {
		const output: unknown = JSON.parse(text);
		return typeof output === "object" && output !== null ? output : null;
	} catch {
		return null;
	}
}

/** A tool's result as text: Claude Code sends it as a string or as content blocks. */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			const text = textBlock.safeParse(block);
			return text.success ? [text.data.text] : [];
		})
		.join("\n");
}

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function byteSize(value: unknown): number {
	return new TextEncoder().encode(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
		.length;
}

function failed(error: string): ClaudeCodeOutcome {
	return { status: "failed", error };
}
