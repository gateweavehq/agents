/**
 * Claude Code as an agent's engine (`./engines.ts`): Anthropic's Claude Code CLI, run in the
 * conversation's sandbox in place of Gateweave's own loop. It reads the repository's CLAUDE.md,
 * skills and settings as it would on a laptop. Its model requests are metered where they leave the
 * sandbox (`./meter.ts`), one span each, and each of its tool calls is a tool span. One conversation is one Claude Code session, whose id the sandbox
 * chooses.
 *
 * Gateweave's tools reach it as the MCP server `gateweave` (`./engine-tools.ts`), whose tools it
 * calls `mcp__gateweave__<tool>`. Their calls come to the chat under their own names, and record
 * their own spans, as in Gateweave's loop.
 *
 * Checked 2026-10-29:
 * - headless runs and their flags: https://code.claude.com/docs/en/headless
 * - permission modes, and why not `bypassPermissions` (it refuses to run as root, as the sandbox's
 *   commands do): https://code.claude.com/docs/en/permission-modes
 * - `--mcp-config`, `--strict-mcp-config`, a server's `timeout` and `alwaysLoad`, and
 *   `mcp__<server>` in allowed tools: https://code.claude.com/docs/en/cli-reference and
 *   https://code.claude.com/docs/en/mcp
 * - per-request limits of HTTP servers and automatic backgrounding:
 *   https://code.claude.com/docs/en/env-vars (`MCP_TOOL_TIMEOUT`,
 *   `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`)
 * - `--settings` above the repository's own settings files, and `attribution`:
 *   https://code.claude.com/docs/en/settings and the settings reference. Checked 2026-10-31 against
 *   Claude Code 2.1.308 and a fake Anthropic API: with it, the instructions the CLI sends the model
 *   no longer ask for the Co-Authored-By trailer or the "Generated with Claude Code" line
 * - the events' shapes: `SDKMessage` in `sdk.d.ts` of @anthropic-ai/claude-agent-sdk 0.3.312
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
	type EngineOutcome,
	type EngineTurn,
	enginePrompt,
	failed,
	MAX_CHAT_OUTPUT,
	outputOf,
	UNFINISHED,
} from "./engines";
import type { RunRecorder } from "./trace";

/** The server the trace and the chat name for Claude Code's own tools. */
export const CLAUDE_CODE_SERVER = "claude-code";

/** What Claude Code calls Gateweave's tools, before their own names. */
export const CLAUDE_CODE_TOOL_PREFIX = `mcp__${ENGINE_TOOLS_SERVER}__`;

/** What the CLI sends as its key, which `SandboxOutbound` replaces with the workspace's. */
export const CLAUDE_CODE_PLACEHOLDER_KEY = "sk-ant-gateweave-sandbox-placeholder";

/** The agentic turns one message may take, each a model request and the tools it calls. */
export const CLAUDE_CODE_TURNS = 100;

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
 * The `--settings` the CLI runs with, over the repository's own. Claude Code would sign its work:
 * a Co-Authored-By trailer on commits and a "Generated with Claude Code" line in pull requests. The
 * pull requests an agent opens are the workspace's, and their run page already says how they came
 * about, so it signs nothing.
 */
export const CLAUDE_CODE_SETTINGS = JSON.stringify({ attribution: { commit: "", pr: "" } });

/**
 * The `--mcp-config` that names Gateweave's tools server. Its `timeout`, the turn's own limit,
 * lifts the 60 seconds an HTTP server's request may take otherwise: a delegated task can take that
 * long. `alwaysLoad` gives the model the tools in its first request, as Gateweave's loop does.
 * Otherwise the CLI connects in the background, sends the first request without them, and later
 * keeps them behind its tool search, a step the model would have to take first.
 */
export function claudeCodeMcpConfig(timeoutMs: number): string {
	return JSON.stringify({
		mcpServers: {
			[ENGINE_TOOLS_SERVER]: {
				type: "http",
				url: ENGINE_TOOLS_URL,
				timeout: timeoutMs,
				alwaysLoad: true,
			},
		},
	});
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
	const allowed = options.tools ? [...ALLOWED_TOOLS, `mcp__${ENGINE_TOOLS_SERVER}`] : ALLOWED_TOOLS;
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
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
		"--settings",
		CLAUDE_CODE_SETTINGS,
		"--strict-mcp-config",
		...(options.tools ? ["--mcp-config", claudeCodeMcpConfig(ENGINE_SECONDS * 1000)] : []),
		...(options.system === "" ? [] : ["--append-system-prompt", options.system]),
		...(options.resume ? ["--resume", options.session] : ["--session-id", options.session]),
	];
}

/**
 * How the sandbox runs a turn of Claude Code: in the session `session`, resumed when the sandbox
 * still has its transcript, with the message on its input.
 */
export function claudeCodeCommand(job: EngineJob, session: string, resume: boolean): EngineCommand {
	const tools = job.access.tools !== null;
	return {
		argv: [
			"claude",
			...claudeCodeArguments({ model: job.model, system: job.system, session, resume, tools }),
		],
		env: CLAUDE_CODE_ENV,
		input: enginePrompt(job, resume),
		log: CLAUDE_CODE_LOG,
	};
}

/** The longest failure of a tool the trace records. */
const TRACE_ERROR_LIMIT = 500;

/**
 * The model Claude Code names on a message it writes itself, such as why a request failed. Its text
 * is meant for a terminal ("Invalid API key · Fix external API key"), and no request made it.
 */
const SYNTHETIC_MODEL = "<synthetic>";

/** The longest part of Claude Code's own words a failure it has no name for quotes. */
const FAILURE_DETAIL_LIMIT = 300;

const assistantEvent = z.object({
	type: z.literal("assistant"),
	parent_tool_use_id: z.string().nullish(),
	error: z.string().optional(),
	message: z.object({
		id: z.string(),
		model: z.string().optional(),
		content: z.array(z.unknown()),
	}),
});

const userEvent = z.object({
	type: z.literal("user"),
	parent_tool_use_id: z.string().nullish(),
	message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
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
 * go to the chat, a subagent's only to the trace, which records every tool call.
 */
export class ClaudeCodeTurn implements EngineTurn {
	readonly #sink: ChunkSink;
	readonly #run: RunRecorder;
	readonly #agent: AgentSnapshot;
	/** The model's answers seen so far, by their message's id: each comes in several events. */
	readonly #answers = new Set<string>();
	readonly #tools = new Map<string, ToolCall>();
	/** Whether the chat has a step open, from the main conversation's answer it shows. */
	#stepOpen = false;
	#result: z.infer<typeof resultEvent> | null = null;
	/** Why a model request failed, as Claude Code names it. */
	#apiError: string | null = null;
	/** What Claude Code last said itself, which a failure it has no name for quotes. */
	#detail: string | null = null;

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
		if (result.success) this.#result = result.data;
	}

	/** Ends what is still open and says how the turn went. */
	end(): EngineOutcome {
		this.#closeStep();
		const result = this.#result;
		if (!result) return UNFINISHED;
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
		if (!this.#answers.has(message.id)) {
			this.#answers.add(message.id);
			if (parent === null) {
				this.#closeStep();
				this.#sink.write({ type: "start-step" });
				this.#stepOpen = true;
			}
		}
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
			const text = contentText(result.data.content);
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

	#closeStep(): void {
		if (!this.#stepOpen) return;
		this.#sink.write({ type: "finish-step" });
		this.#stepOpen = false;
	}
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
