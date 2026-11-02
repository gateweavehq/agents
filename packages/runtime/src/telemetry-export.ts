/**
 * Sends each run's trace to the workspace's OpenTelemetry endpoint once the run ends
 * (`./otlp.ts`). A run waits in the conversation's own SQLite (`otel_outbox`) until it is sent,
 * so an endpoint that is down, or a restart, loses nothing: a failed send is tried again later,
 * a few times, and then given up. Exporting never fails or holds up a run.
 *
 * The registry opens the endpoint's headers for each send (`telemetryTarget`), like a model key
 * for a turn; they stay in this call's memory.
 */
import type { TelemetryExportResult, TelemetryTarget, TotaledRun } from "@gateweave/agents-model";
import { runTraces } from "./otlp";
import { readTrace, type Sql } from "./trace";

/** What the export asks of the workspace's registry. */
export interface TelemetryRegistry {
	telemetryTarget(): Promise<TelemetryTarget | null>;
	getRun(runId: string): Promise<TotaledRun | null>;
	recordTelemetryExport(setAt: number, result: TelemetryExportResult): Promise<boolean>;
}

/** How long the endpoint has to answer. */
export const EXPORT_TIMEOUT_MS = 10_000;

/** Tries a run gets before it is given up; each waits four times as long as the one before. */
export const EXPORT_ATTEMPTS = 5;
export const FIRST_RETRY_SECONDS = 30;

export function createOutbox(sql: Sql): void {
	sql`CREATE TABLE IF NOT EXISTS otel_outbox (
		run_id TEXT PRIMARY KEY,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_at INTEGER NOT NULL
	)`;
}

/** Puts a run that ended in line to be sent. */
export function queueExport(sql: Sql, runId: string, now = Date.now()): void {
	sql`INSERT OR IGNORE INTO otel_outbox (run_id, next_at) VALUES (${runId}, ${now})`;
}

/**
 * Sends the runs that are due, one at a time. Returns when the next try is due, in milliseconds
 * from the epoch, or null when nothing waits.
 */
export async function sendDue(
	sql: Sql,
	registry: TelemetryRegistry,
	workspaceId: string,
	now = () => Date.now(),
): Promise<number | null> {
	const due = sql<{ run_id: string; attempts: number }>`
		SELECT run_id, attempts FROM otel_outbox WHERE next_at <= ${now()} ORDER BY next_at`;
	for (const { run_id: runId, attempts } of due) {
		const outcome = await sendRun(sql, registry, workspaceId, runId);
		if (outcome !== "retry" || attempts + 1 >= EXPORT_ATTEMPTS) {
			sql`DELETE FROM otel_outbox WHERE run_id = ${runId}`;
			continue;
		}
		const wait = FIRST_RETRY_SECONDS * 4 ** attempts * 1000;
		sql`UPDATE otel_outbox SET attempts = ${attempts + 1}, next_at = ${now() + wait}
			WHERE run_id = ${runId}`;
	}
	const [next] = sql<{ at: number | null }>`SELECT min(next_at) AS at FROM otel_outbox`;
	return next?.at ?? null;
}

/** Sends one run: `done` when it went, or when there is nothing to send it to or with. */
async function sendRun(
	sql: Sql,
	registry: TelemetryRegistry,
	workspaceId: string,
	runId: string,
): Promise<"done" | "retry"> {
	const target = await registry.telemetryTarget();
	if (!target) return "done";
	const run = await registry.getRun(runId);
	if (!run) return "done";
	const body = JSON.stringify(runTraces(workspaceId, run, readTrace(sql, runId)));
	const result = await post(target, body);
	await registry
		.recordTelemetryExport(
			target.setAt,
			result.ok ? { ok: true } : { ok: false, error: result.error },
		)
		.catch(() => false);
	if (result.ok) return "done";
	return result.retry ? "retry" : "done";
}

type Posted = { ok: true } | { ok: false; error: string; retry: boolean };

async function post(target: TelemetryTarget, body: string): Promise<Posted> {
	let response: Response;
	try {
		response = await fetch(target.url, {
			method: "POST",
			headers: { ...target.headers, "content-type": "application/json" },
			body,
			// The headers carry a key: they never follow a redirect elsewhere.
			redirect: "manual",
			signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			ok: false,
			error: timedOut
				? `The endpoint did not answer within ${EXPORT_TIMEOUT_MS / 1000} seconds`
				: "The endpoint could not be reached",
			retry: true,
		};
	}
	await response.body?.cancel();
	if (response.ok) return { ok: true };
	const { status } = response;
	if (status >= 300 && status < 400) {
		return {
			ok: false,
			error: `The endpoint sends traces to another address, which they do not follow (HTTP ${status})`,
			retry: false,
		};
	}
	if (status === 401 || status === 403) {
		return {
			ok: false,
			error: `The endpoint refused the headers (HTTP ${status}). Check its API key`,
			retry: false,
		};
	}
	// Too many requests and the endpoint's own failures pass; anything else will not.
	const retry = status === 429 || status >= 500;
	return { ok: false, error: `The endpoint answered with an error (HTTP ${status})`, retry };
}
