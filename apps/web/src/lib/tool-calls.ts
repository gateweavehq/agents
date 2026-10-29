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
