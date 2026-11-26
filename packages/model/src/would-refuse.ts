import type { RunSpan } from "./entities";
import type { WouldRefuseCounts } from "./inputs";

export function isWouldRefuse(span: RunSpan): boolean {
	return (
		span.status === "would_refuse" ||
		((span.kind === "tool" || span.kind === "edge") &&
			span.status !== "refused" &&
			span.target?.decision === "would_refuse")
	);
}

export function countWouldRefuse(spans: readonly RunSpan[]): WouldRefuseCounts {
	const counts = { total: 0, email: 0, url: 0, ip: 0 };
	for (const span of spans) {
		if (!isWouldRefuse(span)) continue;
		counts.total++;
		if ((span.kind === "tool" || span.kind === "edge") && span.target) counts[span.target.kind]++;
	}
	return counts;
}
