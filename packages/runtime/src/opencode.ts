/**
 * OpenCode as an agent's engine (`./engines.ts`): the open-source OpenCode CLI, run in the
 * conversation's sandbox in place of Gateweave's own loop, with the agent's Anthropic, OpenAI or
 * Google model. Its server runs in the sandbox, and each turn is a message to it
 * (`./opencode-server.ts`), whose events come out as `opencode run --format json` prints them. It
 * reads the repository's AGENTS.md and opencode.json as it would on a laptop. Its model requests
 * are metered where they leave the sandbox (`./meter.ts`), one span each, those of the subagents
 * its `task` tool starts too, and each of its tool calls is a tool span. One conversation is one OpenCode session, which each turn continues while the sandbox has
 * it.
 *
 * Gateweave's tools reach it as the MCP server `gateweave` (`./engine-tools.ts`), whose tools it
 * calls `gateweave_<tool>`. Their calls come to the chat under their own names, and record their
 * own spans, as in Gateweave's loop.
 *
 * Checked 2026-10-30 against OpenCode 1.19.5, in its source (the tag `v1.19.5` of
 * github.com/anomalyco/opencode) and with the CLI against fake Anthropic and OpenAI APIs:
 * - `opencode run` and its flags: `packages/opencode/src/cli/cmd/run.ts`. With `--format json` it
 *   prints each step's start and finish, a text once it is whole and a tool call once it has its
 *   result, of its own session alone: a subagent's session, which its `task` tool starts, prints
 *   nothing, so the chat and the tool spans have only the main session's
 * - a step is one model request
 * - settings: those of `OPENCODE_CONFIG_CONTENT` are read after the repository's `opencode.json`,
 *   so theirs win (`config/config.ts`), and `instructions` takes only files, which follow the
 *   repository's AGENTS.md in the system prompt (`session/instruction.ts`)
 * - a new session without a title asks the provider's small model for one (`ensureTitle` in
 *   `session/prompt.ts`): the sandbox names it instead
 * - what it fetches otherwise, and the variables that stop it: its list of models
 *   (models.opencode.ai), its updates, language servers, and `@opencode-ai/plugin` from npm into
 *   its settings folder, which the image installs instead
 * - failures: `{"type":"error"}` with the provider's status (`APIError`), once five retries of a
 *   request that may succeed later have failed too (`session/retry.ts`)
 */
import {
	type AgentSnapshot,
	MODEL_PROVIDER_NAMES,
	type ModelProvider,
} from "@gateweave/agents-model";
import { z } from "zod";
import { ENGINE_TOOLS_SERVER, ENGINE_TOOLS_URL } from "./engine-tools";
import {
	byteSize,
	type ChunkSink,
	clip,
	ENGINE_SECONDS,
	type EngineJob,
	type EngineOutcome,
	type EngineTurn,
	failed,
	MAX_CHAT_OUTPUT,
	outputOf,
	UNFINISHED,
	withoutKeys,
} from "./engines";
import { ANTHROPIC_API, GOOGLE_API, OPENAI_API } from "./outbound";
import type { RunRecorder } from "./trace";

/** The server the trace and the chat name for OpenCode's own tools. */
export const OPENCODE_SERVER = "opencode";

/** What OpenCode calls Gateweave's tools, before their own names. */
export const OPENCODE_TOOL_PREFIX = `${ENGINE_TOOLS_SERVER}_`;

/** What the CLI sends as its key, which `SandboxOutbound` replaces with the workspace's. */
export const OPENCODE_PLACEHOLDER_KEY = "sk-gateweave-sandbox-placeholder";

/**
 * Where the turn's instructions go: OpenCode takes none on its command line, only files named in
 * its settings. The sandbox writes them there before each turn.
 */
export const OPENCODE_INSTRUCTIONS = "/tmp/gateweave-instructions.md";

/**
 * The providers' APIs, as OpenCode calls them, for those it runs with here: their own addresses,
 * whatever the repository's settings say, since no other gets out of the sandbox.
 */
const PROVIDER_URLS: Partial<Record<ModelProvider, string>> = {
	anthropic: `https://${ANTHROPIC_API}/v1`,
	openai: `https://${OPENAI_API}/v1`,
	google: `https://${GOOGLE_API}/v1beta`,
};

/**
 * Its settings for a turn, read after the repository's. The agent's model, the only one it calls,
 * with the placeholder for a key: even for the small tasks it would give a cheaper model. Nothing
 * else it would send gets out of the sandbox, so it sends none: no updates or shared sessions. Its
 * `webfetch` tool stays off, as the sandbox reaches no website. Its snapshots of the work, for undoing it in its
 * own interface, are left out too.
 */
export function openCodeConfig(options: {
	provider: ModelProvider;
	model: string;
	instructions: boolean;
	tools: boolean;
}): Record<string, unknown> {
	const { provider, model } = options;
	const url = PROVIDER_URLS[provider];
	if (url === undefined) {
		throw new Error(`OpenCode does not call ${MODEL_PROVIDER_NAMES[provider]}'s models here`);
	}
	const name = `${provider}/${model}`;
	return {
		$schema: "https://opencode.ai/config.json",
		model: name,
		small_model: name,
		enabled_providers: [provider],
		// A model missing from its own list still runs: only its limits are unknown.
		provider: {
			[provider]: {
				options: { baseURL: url, apiKey: OPENCODE_PLACEHOLDER_KEY },
				models: { [model]: {} },
			},
		},
		autoupdate: false,
		share: "disabled",
		snapshot: false,
		tools: { webfetch: false },
		...(options.instructions ? { instructions: [OPENCODE_INSTRUCTIONS] } : {}),
		// A delegated task can take as long as the turn may: the timeout covers each call.
		...(options.tools
			? {
					mcp: {
						[ENGINE_TOOLS_SERVER]: {
							type: "remote",
							url: ENGINE_TOOLS_URL,
							oauth: false,
							timeout: ENGINE_SECONDS * 1000,
						},
					},
				}
			: {}),
	};
}

/** What the server runs with besides the sandbox's usual environment: its settings, and no fetches. */
export function openCodeEnv(config: Record<string, unknown>): Record<string, string> {
	return {
		OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
		// Its built-in plugins sign in to other providers, which it does not call here.
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
	};
}

/**
 * What OpenCode's server runs with for the job's turn, which starts it over when they differ from
 * the last turn's. The sandbox has written the turn's instructions, if any, to
 * `OPENCODE_INSTRUCTIONS` first.
 */
export function openCodeSettings(
	job: Pick<EngineJob, "provider" | "model" | "system" | "access">,
): Record<string, string> {
	return openCodeEnv(
		openCodeConfig({
			provider: job.provider,
			model: job.model,
			instructions: job.system !== "",
			tools: job.access.tools !== null,
		}),
	);
}

/** The longest failure of a tool the trace records. */
const TRACE_ERROR_LIMIT = 500;

/** The longest part of OpenCode's own words a failure it has no name for quotes. */
const FAILURE_DETAIL_LIMIT = 300;

const timeSchema = z.object({ start: z.number(), end: z.number() });

const stepStart = z.object({ type: z.literal("step_start") });
const stepFinish = z.object({
	type: z.literal("step_finish"),
	part: z.object({ reason: z.string().nullish() }),
});
const textEvent = z.object({
	type: z.literal("text"),
	part: z.object({ text: z.string() }),
});
const toolUse = z.object({
	type: z.literal("tool_use"),
	part: z.object({
		callID: z.string(),
		tool: z.string(),
		state: z.discriminatedUnion("status", [
			z.object({
				status: z.literal("completed"),
				input: z.unknown(),
				output: z.string(),
				time: timeSchema,
			}),
			z.object({
				status: z.literal("error"),
				input: z.unknown(),
				error: z.string(),
				time: timeSchema,
			}),
		]),
	}),
});
const errorSchema = z.object({
	name: z.string().optional(),
	data: z
		.object({
			message: z.string().optional(),
			statusCode: z.number().optional(),
			responseBody: z.string().optional(),
		})
		.loose()
		.optional(),
});
const errorEvent = z.object({ type: z.literal("error"), error: errorSchema });

type OpenCodeError = z.infer<typeof errorSchema>;

/**
 * Follows one turn of OpenCode, an event at a time. Its text and tool calls go to the chat, and its
 * tool calls to the trace.
 */
export class OpenCodeTurn implements EngineTurn {
	readonly #sink: ChunkSink;
	readonly #run: RunRecorder;
	readonly #agent: AgentSnapshot;
	/** Whether the chat's step is open: one model request and the tools it called. */
	#open = false;
	/** When the step began, before which none of its tools did. */
	#stepFrom = 0;
	/** Whether a request finished, so the turn did not stop before its first answer. */
	#answered = false;
	/** Why the turn failed, in OpenCode's words. */
	#failure: OpenCodeError | null = null;

	constructor(sink: ChunkSink, run: RunRecorder, agent: AgentSnapshot) {
		this.#sink = sink;
		this.#run = run;
		this.#agent = agent;
	}

	/** Takes one line of OpenCode's output. Anything not an event it knows is left alone. */
	take(line: string, now = Date.now()): void {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (stepStart.safeParse(event).success) {
			this.#closeStep();
			this.#open = true;
			this.#stepFrom = now;
			this.#sink.write({ type: "start-step" });
			return;
		}
		const tool = toolUse.safeParse(event);
		if (tool.success) {
			this.#tool(tool.data.part, now);
			return;
		}
		const text = textEvent.safeParse(event);
		if (text.success) {
			if (text.data.part.text.trim() === "") return;
			const id = crypto.randomUUID();
			this.#sink.write({ type: "text-start", id });
			this.#sink.write({ type: "text-delta", id, delta: text.data.part.text });
			this.#sink.write({ type: "text-end", id });
			return;
		}
		const finish = stepFinish.safeParse(event);
		if (finish.success) {
			if (this.#open) this.#answered = true;
			this.#closeStep();
			return;
		}
		const error = errorEvent.safeParse(event);
		if (error.success) {
			this.#failure = error.data.error;
			this.#closeStep();
		}
	}

	/** Ends what is still open and says how the turn went. */
	end(): EngineOutcome {
		const stopped = this.#open;
		this.#closeStep();
		if (this.#failure !== null) return failed(describeFailure(this.#agent, this.#failure));
		return this.#answered && !stopped ? { status: "succeeded" } : UNFINISHED;
	}

	/**
	 * A tool call, which OpenCode prints once it has its result: its span starts back when it began,
	 * by how long it took, so the clocks of the sandbox and the Worker need not agree.
	 */
	#tool(part: z.infer<typeof toolUse>["part"], now: number): void {
		const { callID: id, tool, state } = part;
		const took = Math.max(0, state.time.end - state.time.start);
		const started = Math.max(this.#stepFrom, now - took);
		const gateweave = tool.startsWith(OPENCODE_TOOL_PREFIX);
		// Gateweave's tools go by their own names, so the chat shows them as it does in Gateweave's
		// loop: a pull request as its link, an edge as the member it reached. They record their own
		// spans.
		this.#sink.write({
			type: "tool-input-available",
			toolCallId: id,
			toolName: gateweave ? tool.slice(OPENCODE_TOOL_PREFIX.length) : `${OPENCODE_SERVER}__${tool}`,
			input: state.input,
			dynamic: true,
		});
		const span = gateweave
			? null
			: this.#run.toolStarted(OPENCODE_SERVER, tool, byteSize(state.input), started);
		if (state.status === "error") {
			if (span !== null) {
				this.#run.toolEnded(span, { error: clip(state.error, TRACE_ERROR_LIMIT) }, now);
			}
			this.#sink.write({
				type: "tool-output-error",
				toolCallId: id,
				errorText: clip(state.error, MAX_CHAT_OUTPUT),
				dynamic: true,
			});
			return;
		}
		if (span !== null) {
			this.#run.toolEnded(span, { outputBytes: byteSize(state.output), error: null }, now);
		}
		this.#sink.write({
			type: "tool-output-available",
			toolCallId: id,
			output: (gateweave && outputOf(state.output)) || {
				text: clip(state.output, MAX_CHAT_OUTPUT),
			},
			dynamic: true,
		});
	}

	/** Ends the chat's step, if it is open. */
	#closeStep(): void {
		if (!this.#open) return;
		this.#open = false;
		this.#sink.write({ type: "finish-step" });
	}
}

/**
 * Why OpenCode's turn failed, in the same words as a turn of Gateweave's own loop. What it says
 * otherwise is quoted with anything like a key taken out: providers' errors repeat part of it.
 */
function describeFailure(agent: AgentSnapshot, failure: OpenCodeError | null): string {
	if (failure === null) return "OpenCode stopped before it finished.";
	const name = MODEL_PROVIDER_NAMES[agent.provider];
	const status = failure.data?.statusCode ?? 0;
	const words = failure.data?.message ?? failure.name ?? "";
	const said = `${words} ${failure.data?.responseBody ?? ""}`;
	if (status === 401 || status === 403) {
		return `${name} refused the workspace's key. An owner or admin can check it in Settings.`;
	}
	if (status === 404) return `${name} has no model ${agent.model} for the workspace's key.`;
	if (/insufficient_quota|credit balance/i.test(said)) {
		return `${name} refused the workspace's key for its billing. An owner can check the account.`;
	}
	if (status === 429) return `${name} is limiting the workspace's requests. Try again shortly.`;
	if (status >= 500) return `${name} could not answer just now. Try again shortly.`;
	if (words === "") return "OpenCode could not finish.";
	return `OpenCode could not finish: ${clip(withoutKeys(words), FAILURE_DETAIL_LIMIT)}`;
}
