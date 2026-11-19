import { EDGE_PART, TEAM_EDGE_KINDS, type TeamEdgeKind } from "@gateweave/agents-model";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ToolCallPart } from "./tool-calls";

/** The input field each kind of edge carries its text in. */
const EDGE_INPUTS: Record<TeamEdgeKind, string> = {
	delegate: "task",
	ask: "question",
	report: "message",
};

/**
 * The run each call over a team's edge started, by the id the chat shows the call under.
 * Gateweave's own loop names the call by its tool call id, and its part carries that; an engine's
 * chat names the call by the engine's own id, which the tool never sees, so its part carries the
 * tool's name and text, and the call is found by those. Calls from before the parts existed, and
 * ones whose edge never reached a run, have none; so do calls the words cannot tell apart.
 */
export function edgeRunsOf(message: UIMessage): Map<string, string> {
	const runs = new Map<string, string>();
	const byWords: { toolName: string; text: string; runId: string }[] = [];
	for (const part of message.parts) {
		if (part.type !== EDGE_PART) continue;
		const data = (part as { data?: unknown }).data;
		if (typeof data !== "object" || data === null) continue;
		const { toolCallId, toolName, text, runId } = data as {
			toolCallId?: unknown;
			toolName?: unknown;
			text?: unknown;
			runId?: unknown;
		};
		if (typeof runId !== "string" || runId.length === 0) continue;
		if (typeof toolCallId === "string" && toolCallId.length > 0) {
			runs.set(toolCallId, runId);
		} else if (typeof toolName === "string" && typeof text === "string") {
			byWords.push({ toolName, text, runId });
		}
	}
	if (byWords.length === 0) return runs;
	const calls = message.parts.filter(isToolUIPart);
	for (const { toolName, text, runId } of byWords) {
		// Two calls with the same words are indistinguishable here: neither gets a link, rather
		// than one of them a link to the other's run.
		const matches = calls.filter(
			(part) => getToolName(part) === toolName && edgeTextOf(part) === text,
		);
		const only = matches.length === 1 ? matches[0] : undefined;
		if (only && !runs.has(only.toolCallId)) runs.set(only.toolCallId, runId);
	}
	return runs;
}

/** The text an edge call carried, from its input, or null when it is not an edge call's. */
function edgeTextOf(part: ToolCallPart): string | null {
	const name = getToolName(part);
	const kind = TEAM_EDGE_KINDS.find((each) => name.startsWith(`${each}__`));
	if (!kind) return null;
	const input: unknown = part.input;
	if (typeof input !== "object" || input === null) return null;
	const value = (input as Record<string, unknown>)[EDGE_INPUTS[kind]];
	return typeof value === "string" ? value : null;
}
