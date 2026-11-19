import { TURN_PROGRESS_PART } from "@gateweave/agents-model";

/**
 * The label of a turn's transient progress part: the text to show, `null` when the part clears
 * the line, or `undefined` when the chunk is not a progress part at all (AGT-139).
 */
export function turnProgressOf(chunk: unknown): string | null | undefined {
	if (typeof chunk !== "object" || chunk === null) return undefined;
	if ((chunk as { type?: unknown }).type !== TURN_PROGRESS_PART) return undefined;
	const data = (chunk as { data?: unknown }).data;
	if (typeof data !== "object" || data === null) return undefined;
	const label = (data as { label?: unknown }).label;
	return typeof label === "string" ? label : null;
}
