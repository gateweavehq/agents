import { RUN_PART } from "@gateweave/agents-model";
import type { UIMessage } from "ai";

/**
 * The run a reply's data part names, or null when it has none: replies from before the part
 * existed, and ones whose turn never reached a run, carry nothing to link.
 */
export function runIdOf(message: UIMessage): string | null {
	for (const part of message.parts) {
		if (part.type !== RUN_PART) continue;
		const data = (part as { data?: unknown }).data;
		if (typeof data !== "object" || data === null) continue;
		const runId = (data as { runId?: unknown }).runId;
		if (typeof runId === "string" && runId.length > 0) return runId;
	}
	return null;
}
