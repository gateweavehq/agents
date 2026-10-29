/**
 * Vendor coding agents as an agent's engine (AGT-44). A turn of an agent whose engine is not
 * Gateweave's own loop runs the vendor's CLI in the conversation's sandbox: Claude Code
 * (`./claude-code.ts`). The CLI reads the repository's own instructions and settings as it would on
 * a laptop and works with its own tools, and the turn passes on what it does as its events come:
 * its text and tool calls to the chat, and its model requests and tool calls to the run's trace.
 *
 * The CLI holds no key. It sends a placeholder, and `SandboxOutbound` puts the workspace's key on
 * its requests to the model's provider on the way out, while the turn runs (`./outbound.ts`). The
 * turn's other tools reach it as one MCP server that the conversation answers
 * (`./engine-tools.ts`). One conversation is one session of the CLI, which each turn resumes while
 * the sandbox has it.
 */
import {
	type AgentEngine,
	PULL_REQUEST_TOOL,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import type { UIMessage, UIMessageChunk } from "ai";
import { ENGINE_TOOLS_SERVER, type EngineToolsAccess } from "./engine-tools";
import type { GatewayMetadata } from "./models";

/** The engines that run in the sandbox: every one but Gateweave's own loop. */
export type SandboxEngine = Exclude<AgentEngine, "gateweave">;

/** How long one turn may run before the sandbox stops it. */
export const ENGINE_SECONDS = 60 * 60;

/**
 * What the turn's requests out of the sandbox go with: the workspace's key and what AI Gateway
 * logs about its requests to the model, and the way to Gateweave's tools, if the turn has any.
 */
export interface EngineAccess {
	key: string;
	metadata: GatewayMetadata;
	tools: EngineToolsAccess | null;
}

/** A turn for an engine, as the conversation hands it to its sandbox. */
export interface EngineJob {
	engine: SandboxEngine;
	/** The person's message. */
	prompt: string;
	/** The conversation so far, for a sandbox that no longer has its session; null for none. */
	history: string | null;
	/** What the CLI reads after its own instructions. */
	system: string;
	model: string;
	/** Where it works: the repository's checkout, or the sandbox's root. */
	cwd: string;
	access: EngineAccess;
}

/** What a conversation reaches of its sandbox to run an engine. */
export interface EnginePort {
	/** Starts the turn. Its events, one JSON object a line, as the CLI writes them. */
	startEngine(job: EngineJob): Promise<ReadableStream<Uint8Array>>;
	/** Ends the turn under way: the CLI finishes it as it would on Ctrl+C, or is killed. */
	stopEngine(): Promise<void>;
}

/** The engine running a turn in a sandbox, and what its requests out of the sandbox go with. */
export interface RunningEngine {
	engine: SandboxEngine;
	access: EngineAccess;
}

/** How the sandbox runs a turn: the command, what it runs with, and what goes on its input. */
export interface EngineCommand {
	argv: string[];
	env: Record<string, string>;
	input: string;
	/** Where the CLI's own messages go in the sandbox, out of the events' way. */
	log: string;
}

/** Where a turn's chat chunks go: the stream the conversation answers with. */
export interface ChunkSink {
	write(chunk: UIMessageChunk): void;
}

/** How a turn of an engine went. */
export type EngineOutcome = { status: "succeeded" } | { status: "failed"; error: string };

/** Follows one turn of an engine, a line of its output at a time. */
export interface EngineTurn {
	/** Takes one line of the CLI's output. Anything not an event it knows is left alone. */
	take(line: string, now?: number): void;
	/** Ends what is still open and says how the turn went. */
	end(now?: number): EngineOutcome;
}

/** What the CLI reads first: the message, after the conversation so far when it lost that. */
export function enginePrompt(job: EngineJob, resumed: boolean): string {
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
 * What the CLI is told of where it runs, after the agent's instructions. With `pullRequests`, it
 * proposes its work with Gateweave's `open_pull_request`; without, it says what it changed.
 */
export function engineNote(
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
			? `git push does not work from the sandbox. To propose your work, call ${PULL_REQUEST_TOOL} (a tool of the ${ENGINE_TOOLS_SERVER} MCP server): it commits what you changed in the checkout and opens a pull request, or updates the one the branch has.`
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

/** Most characters of a tool's result the chat keeps: the CLI has the whole of it. */
export const MAX_CHAT_OUTPUT = 4_000;

/**
 * The output of one of Gateweave's tools, which its server sent as JSON text, as the chat shows it
 * in Gateweave's loop; null for text that is not a JSON object, or too long for the chat.
 */
export function outputOf(text: string): object | null {
	if (text.length > MAX_CHAT_OUTPUT) return null;
	try {
		const output: unknown = JSON.parse(text);
		return typeof output === "object" && output !== null ? output : null;
	} catch {
		return null;
	}
}

/** A tool's result as text: a string, or MCP's content blocks, of which the text ones count. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

export function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function byteSize(value: unknown): number {
	return new TextEncoder().encode(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
		.length;
}

export function failed(error: string): EngineOutcome {
	return { status: "failed", error };
}
