import type { Run, RunStatus } from "@gateweave/agents-model";
import { LoaderCircle } from "lucide-react";
import { formatDuration, formatTokens } from "#/lib/usage";
import { cn } from "#/lib/utils";

const STATUSES: Record<RunStatus, { label: string; className: string }> = {
	running: { label: "Running", className: "text-sky-700 dark:text-sky-400" },
	succeeded: { label: "Succeeded", className: "text-emerald-700 dark:text-emerald-400" },
	failed: { label: "Failed", className: "text-destructive" },
	stopped: { label: "Stopped", className: "text-muted-foreground" },
	interrupted: { label: "Interrupted", className: "text-amber-700 dark:text-amber-400" },
};

/** How a run ended, or that it is still going. */
export function RunStatusBadge({ status }: { status: RunStatus }) {
	const { label, className } = STATUSES[status];
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap",
				className,
			)}
		>
			{status === "running" && <LoaderCircle aria-hidden className="size-3 animate-spin" />}
			{label}
		</span>
	);
}

/**
 * How long a run took, or has taken so far. A run closed for never reporting back has no end, and
 * no duration.
 */
export function runDuration(
	run: Pick<Run, "status" | "startedAt" | "endedAt">,
	now = Date.now(),
): string {
	const end = run.endedAt ?? (run.status === "running" ? now : null);
	return end === null ? "Unknown" : formatDuration(Math.max(0, end - run.startedAt));
}

/** "1.2K in · 300 out". */
export function tokensUsed({
	inputTokens,
	outputTokens,
}: Pick<Run, "inputTokens" | "outputTokens">) {
	return `${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out`;
}
