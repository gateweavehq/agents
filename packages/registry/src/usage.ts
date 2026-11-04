/**
 * Usage events: one Workers Analytics Engine data point for each run that closes, so whoever runs
 * the server can chart and bill usage across every workspace without reading each registry. The
 * binding (`USAGE`) is optional; without it nothing is written. The registry's runs stay the
 * record each workspace reads; these points are a copy for the deployment, sampled as Analytics
 * Engine samples, and kept for its retention. docs/self-hosting.md has the queries.
 */
import { sandboxCost, type TotaledRun } from "@gateweave/agents-model";

export interface UsageSettings {
	/** The Analytics Engine dataset usage events go to. */
	USAGE?: unknown;
}

/**
 * The order of a usage point's fields, which the queries name as `blob1`… and `double1`…. Append
 * new ones at the end: points already written keep their order.
 */
export const USAGE_BLOBS = [
	"run",
	"agent",
	"agentName",
	"provider",
	"model",
	"status",
	"trigger",
	"rootRun",
] as const;
export const USAGE_DOUBLES = [
	"inputTokens",
	"outputTokens",
	"cachedInputTokens",
	"cost",
	"priced",
	"steps",
	"seconds",
	"sandboxSeconds",
	"sandboxCost",
] as const;

/**
 * A closed run as a data point, indexed (and so sampled) by workspace. Costs are US dollars.
 * Sandbox time counts as the run's figure does when it closes: with the idle minutes after it,
 * which a turn of the same conversation soon after takes back, so summed it is an upper bound.
 */
export function usagePoint(workspace: string, run: TotaledRun): AnalyticsEngineDataPoint {
	const blobs: Record<(typeof USAGE_BLOBS)[number], string> = {
		run: run.id,
		agent: run.agentId,
		agentName: run.agentName,
		provider: run.provider,
		model: run.model,
		status: run.status,
		trigger: run.triggerId ?? "",
		rootRun: run.rootRunId ?? "",
	};
	const sandboxSeconds = run.sandboxSeconds ?? 0;
	const doubles: Record<(typeof USAGE_DOUBLES)[number], number> = {
		inputTokens: run.inputTokens,
		outputTokens: run.outputTokens,
		cachedInputTokens: run.cachedInputTokens,
		cost: (run.cost ?? 0) / 1_000_000,
		priced: run.cost === null ? 0 : 1,
		steps: run.steps,
		seconds: Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt) / 1000,
		sandboxSeconds,
		sandboxCost: sandboxCost(sandboxSeconds) / 1_000_000,
	};
	return {
		indexes: [workspace],
		blobs: USAGE_BLOBS.map((field) => blobs[field]),
		doubles: USAGE_DOUBLES.map((field) => doubles[field]),
	};
}

/** Writes the point when the deployment binds a dataset. Never throws: usage is a copy. */
export function writeUsage(dataset: unknown, point: AnalyticsEngineDataPoint): boolean {
	if (!isDataset(dataset)) return false;
	try {
		dataset.writeDataPoint(point);
		return true;
	} catch (error) {
		console.error("registry: writing a usage event failed", error);
		return false;
	}
}

function isDataset(value: unknown): value is AnalyticsEngineDataset {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { writeDataPoint?: unknown }).writeDataPoint === "function"
	);
}
