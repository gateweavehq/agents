import {
	PULL_REQUEST_TOOL,
	type PullRequestOutcome,
	readEdgeToolName,
	type TeamEdgeKind,
} from "@gateweave/agents-model";
import {
	type DynamicToolUIPart,
	getToolName,
	isToolUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";

/**
 * A tool call in a message. It is dynamic while the reply streams in, since the agent's MCP tools
 * are known only when the turn runs, and static once the conversation has stored it.
 */
export type ToolCallPart = ToolUIPart | DynamicToolUIPart;

export type CallState = "running" | "done" | "failed";

/** The tool calls in a message, live or stored, in the order the model made them. */
export function toolCallsOf(message: UIMessage): ToolCallPart[] {
	return message.parts.filter(isToolUIPart);
}

/**
 * A call of an MCP tool, as the chat shows it: the runtime names each MCP tool `<server>__<tool>`,
 * and MCP reports a tool's own failure inside its result.
 */
export function describeToolCall(part: ToolCallPart): {
	server: string | null;
	tool: string;
	state: CallState;
} {
	const name = getToolName(part);
	const at = name.indexOf("__");
	const server = at > 0 ? name.slice(0, at) : null;
	const tool = at > 0 ? name.slice(at + 2) : name;
	if (part.state === "input-streaming" || part.state === "input-available") {
		return { server, tool, state: "running" };
	}
	const output: unknown = part.state === "output-available" ? part.output : null;
	const failed =
		part.state !== "output-available" ||
		(typeof output === "object" &&
			output !== null &&
			"isError" in output &&
			output.isError === true);
	return { server, tool, state: failed ? "failed" : "done" };
}

/**
 * A call over one of a team's edges, by its kind and the member it went to, or null for any other
 * tool. `members` are the names of the team's members; a refusal comes back as the call's error.
 */
export function describeEdgeCall(
	part: ToolCallPart,
	members: readonly string[],
): { edge: TeamEdgeKind; member: string; state: CallState; error: string | null } | null {
	const read = readEdgeToolName(getToolName(part), members);
	if (!read) return null;
	const state: CallState =
		part.state === "input-streaming" || part.state === "input-available"
			? "running"
			: part.state === "output-available"
				? "done"
				: "failed";
	return {
		edge: read.kind,
		member: read.member,
		state,
		error: part.state === "output-error" ? part.errorText : null,
	};
}

/**
 * A call of the sandbox's `open_pull_request`, by the pull request it made, or null for any other
 * tool. Only a link to the pull request's page on GitHub is shown: the output is the runtime's, but
 * the page should not link anywhere else whatever it holds.
 */
export function describePullRequestCall(part: ToolCallPart): {
	state: CallState;
	pullRequest: { number: number; url: string; opened: boolean } | null;
	error: string | null;
} | null {
	if (getToolName(part) !== PULL_REQUEST_TOOL) return null;
	if (part.state === "input-streaming" || part.state === "input-available") {
		return { state: "running", pullRequest: null, error: null };
	}
	if (part.state !== "output-available") {
		return { state: "failed", pullRequest: null, error: part.errorText ?? null };
	}
	const output = part.output as Partial<PullRequestOutcome> | null;
	const { number, url, opened } = output ?? {};
	const linkable =
		typeof number === "number" &&
		typeof url === "string" &&
		/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);
	return {
		state: "done",
		pullRequest: linkable ? { number, url, opened: opened === true } : null,
		error: null,
	};
}

/** The longest a chip's target gets before it is cut; the whole of it stays in the chip's title. */
export const TARGET_CLIP = 60;

/**
 * Arguments that say what a call acted on, in the order they are tried. Only these are ever
 * shown, never a whole input: a tool's arguments can carry a key, a token or a file's content.
 */
const TARGET_ARGUMENTS = [
	"path",
	"file_path",
	"filePath",
	"command",
	"issueKey",
	"issue_key",
	"issue",
	"key",
	"query",
	"pattern",
];

/** Arguments that name an issue: shown only when the value looks like one, such as `TRK-137`. */
const ISSUE_ARGUMENTS = new Set(["issueKey", "issue_key", "issue", "key"]);
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;

/** A name that holds a credential, wherever it is spelled out (`apiKey`, `access_token`). */
const SECRET_NAME = /secret|token|passw|credential|api[-_]?key|private[-_]?key|auth|bearer|cookie/i;

/** A value that carries a credential, such as a command with a header or an assignment. */
const SECRET_VALUE =
	/bearer\s+\S|authorization|cookie|passw|secret|token|api[-_]?key|\b(?:sk|pk|ghp|gho|ghs|ghu|xox[a-z]|whsec|glpat|AKIA)[-_]?[A-Za-z0-9]{8,}|github_pat_/i;

/**
 * What a call acted on, as a chip shows it: `docs/roadmap.md`, `pnpm check`, `TRK-137`. `label` is
 * clipped; `full` is for the title. Null when the stored call has nothing safe to show. A command
 * that carries a credential shows only its program.
 */
export function describeToolTarget(part: ToolCallPart): { label: string; full: string } | null {
	const input: unknown = part.input;
	if (typeof input !== "object" || input === null) return null;
	const args = input as Record<string, unknown>;
	for (const name of TARGET_ARGUMENTS) {
		const raw = args[name];
		if (typeof raw !== "string") continue;
		const value = raw.replace(/\s+/g, " ").trim();
		if (value === "") continue;
		if (ISSUE_ARGUMENTS.has(name)) {
			if (!ISSUE_KEY.test(value)) continue;
		} else if (SECRET_NAME.test(name)) {
			continue;
		}
		if (name === "command") {
			const summary = commandSummary(value);
			if (summary === null) continue;
			return { label: clip(summary, TARGET_CLIP), full: summary };
		}
		if (SECRET_VALUE.test(value)) continue;
		const full = value.slice(0, 500);
		return { label: clip(full, TARGET_CLIP), full };
	}
	return null;
}

/** A word of a command that is safe to show: a name or a path, with nothing that carries a value. */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

/**
 * What a command is, without what it was given: its program and the plain words right after it,
 * `pnpm check` or `git status`. It stops at the first flag, quote, assignment or address, since
 * that is where a password or a token goes (`curl -u name:password …`), and no pattern can know
 * every way to write one. Null when even the program is not a plain word.
 */
function commandSummary(command: string): string | null {
	const words: string[] = [];
	for (const word of command.split(" ")) {
		if (!PLAIN_WORD.test(word) || SECRET_VALUE.test(word)) break;
		words.push(word);
		if (words.length === 3) break;
	}
	return words.length > 0 ? words.join(" ") : null;
}

function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
