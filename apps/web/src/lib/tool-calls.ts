import type { DynamicToolUIPart } from "ai";

/**
 * A tool call in a conversation, as the chat shows it: the runtime names each MCP tool
 * `<server>__<tool>`, and MCP reports a tool's own failure inside its result.
 */
export function describeToolCall(part: DynamicToolUIPart): {
	server: string | null;
	tool: string;
	state: "running" | "done" | "failed";
} {
	const at = part.toolName.indexOf("__");
	const server = at > 0 ? part.toolName.slice(0, at) : null;
	const tool = at > 0 ? part.toolName.slice(at + 2) : part.toolName;
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
