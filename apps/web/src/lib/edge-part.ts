import { EDGE_PART } from "@gateweave/agents-model";
import type { UIMessage } from "ai";

/**
 * The run each call over a team's edge started, by the call's id: what the chat links a delegated
 * answer to. Calls from before the part existed, and ones whose edge never reached a run, have
 * none.
 */
export function edgeRunsOf(message: UIMessage): Map<string, string> {
	const runs = new Map<string, string>();
	for (const part of message.parts) {
		if (part.type !== EDGE_PART) continue;
		const data = (part as { data?: unknown }).data;
		if (typeof data !== "object" || data === null) continue;
		const { toolCallId, runId } = data as { toolCallId?: unknown; runId?: unknown };
		if (
			typeof toolCallId === "string" &&
			toolCallId.length > 0 &&
			typeof runId === "string" &&
			runId.length > 0
		) {
			runs.set(toolCallId, runId);
		}
	}
	return runs;
}
