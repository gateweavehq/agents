/**
 * The trace of each run, kept in the conversation's own SQLite next to its messages: one span per
 * model request, with its timing, tokens, estimated cost and AI Gateway log id. The registry gets
 * the sum when the run ends (`RunFinish`); the trace stays here, private like the conversation,
 * and goes when the conversation is deleted.
 */
import {
	type AgentSnapshot,
	type RunFinish,
	type RunSpan,
	type RunStatus,
	requestCost,
} from "@gateweave/agents-model";
import type { StepResult, ToolSet } from "ai";

type SqlValue = string | number | boolean | null;

/** The Agents SDK's `this.sql`: a synchronous query on the Durable Object's SQLite. */
export type Sql = <T = Record<string, SqlValue>>(
	strings: TemplateStringsArray,
	...values: SqlValue[]
) => T[];

/** What a model span records besides its timing, as JSON in `attributes`. */
type ModelAttributes = Pick<
	RunSpan,
	| "model"
	| "inputTokens"
	| "outputTokens"
	| "cachedInputTokens"
	| "cost"
	| "finishReason"
	| "firstTokenMs"
	| "gatewayLogId"
	| "error"
>;

interface SpanRow {
	id: string;
	step: number;
	status: RunSpan["status"];
	started_at: number;
	ended_at: number | null;
	attributes: string;
}

/** AI Gateway's id for a request's log entry, on its response. */
const GATEWAY_LOG_ID = "cf-aig-log-id";

/** Creates the trace's tables unless they exist. Cheap enough to run on every wake. */
export function createTraceTables(sql: Sql): void {
	sql`CREATE TABLE IF NOT EXISTS trace_runs (
		id TEXT PRIMARY KEY,
		status TEXT NOT NULL,
		started_at INTEGER NOT NULL,
		ended_at INTEGER
	)`;
	sql`CREATE TABLE IF NOT EXISTS trace_spans (
		id TEXT PRIMARY KEY,
		run_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		step INTEGER NOT NULL,
		status TEXT NOT NULL,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		attributes TEXT NOT NULL
	)`;
	sql`CREATE INDEX IF NOT EXISTS trace_spans_run_idx ON trace_spans (run_id, step)`;
}

/** Records one run as it happens. Each method writes at once, so a restart loses nothing. */
export class RunRecorder {
	readonly #sql: Sql;
	readonly #agent: AgentSnapshot;
	readonly runId: string;
	#finished = false;

	constructor(sql: Sql, runId: string, agent: AgentSnapshot, now = Date.now()) {
		this.#sql = sql;
		this.#agent = agent;
		this.runId = runId;
		sql`INSERT INTO trace_runs (id, status, started_at) VALUES (${runId}, 'running', ${now})`;
	}

	stepStarted(step: number, now = Date.now()): void {
		const attributes: ModelAttributes = {
			model: this.#agent.model,
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			cost: 0,
			finishReason: null,
			firstTokenMs: null,
			gatewayLogId: null,
			error: null,
		};
		this.#sql`INSERT INTO trace_spans (id, run_id, kind, step, status, started_at, attributes)
			VALUES (${crypto.randomUUID()}, ${this.runId}, 'model', ${step}, 'running', ${now},
				${JSON.stringify(attributes)})`;
	}

	stepEnded(result: StepResult<ToolSet>, now = Date.now()): void {
		const { usage } = result;
		const tokens = {
			input: usage.inputTokens ?? 0,
			output: usage.outputTokens ?? 0,
			cacheRead: usage.inputTokenDetails.cacheReadTokens ?? 0,
			cacheWrite: usage.inputTokenDetails.cacheWriteTokens ?? 0,
		};
		const model = result.response.modelId || this.#agent.model;
		const { provider } = this.#agent;
		const attributes: ModelAttributes = {
			model,
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			cachedInputTokens: tokens.cacheRead,
			cost:
				requestCost(provider, model, tokens, now) ??
				requestCost(provider, this.#agent.model, tokens, now),
			finishReason: result.finishReason,
			firstTokenMs:
				result.performance.timeToFirstOutputMs === undefined
					? null
					: Math.round(result.performance.timeToFirstOutputMs),
			gatewayLogId: result.response.headers?.[GATEWAY_LOG_ID] ?? null,
			error: null,
		};
		const status = result.finishReason === "error" ? "error" : "ok";
		this.#endStep(result.stepNumber, status, attributes, now);
	}

	/** A request that failed before the model answered, with why in the app's words. */
	stepFailed(step: number, error: string, now = Date.now()): void {
		this.#endStep(step, "error", { error }, now);
	}

	/**
	 * Ends the run, once. Returns what the registry should record, or null when the run had ended
	 * already, since a turn can report its end through more than one callback.
	 */
	finish(status: Exclude<RunStatus, "running">, error: string | null, now = Date.now()) {
		if (this.#finished) return null;
		this.#finished = true;
		return closeRun(this.#sql, this.runId, status, error, now);
	}

	#endStep(
		step: number,
		status: "ok" | "error",
		attributes: Partial<ModelAttributes>,
		now: number,
	): void {
		const [span] = this.#sql<{ id: string; attributes: string }>`
			SELECT id, attributes FROM trace_spans WHERE run_id = ${this.runId} AND step = ${step}`;
		if (!span) return;
		const merged = { ...(JSON.parse(span.attributes) as ModelAttributes), ...attributes };
		this.#sql`UPDATE trace_spans
			SET status = ${status}, ended_at = ${now}, attributes = ${JSON.stringify(merged)}
			WHERE id = ${span.id}`;
	}
}

/** Closes a run and its open spans, and sums it up for the registry. */
function closeRun(
	sql: Sql,
	runId: string,
	status: Exclude<RunStatus, "running">,
	error: string | null,
	endedAt: number,
): Required<RunFinish> {
	sql`UPDATE trace_spans SET status = 'error', ended_at = ${endedAt}
		WHERE run_id = ${runId} AND status = 'running'`;
	sql`UPDATE trace_runs SET status = ${status}, ended_at = ${endedAt} WHERE id = ${runId}`;
	const spans = readTrace(sql, runId);
	const sum = (pick: (span: RunSpan) => number) =>
		spans.reduce((total, span) => total + pick(span), 0);
	return {
		status,
		error,
		steps: spans.length,
		inputTokens: sum((span) => span.inputTokens),
		outputTokens: sum((span) => span.outputTokens),
		cachedInputTokens: sum((span) => span.cachedInputTokens),
		// One request without prices leaves the whole run without an estimate.
		cost: spans.some((span) => span.cost === null) ? null : sum((span) => span.cost ?? 0),
		endedAt,
	};
}

/**
 * Closes the runs a restart cut short, as interrupted, at the last moment the trace saw them
 * move. Returns each one's summary for the registry.
 */
export function closeInterruptedRuns(sql: Sql): { runId: string; finish: Required<RunFinish> }[] {
	const open = sql<{ id: string; started_at: number }>`
		SELECT id, started_at FROM trace_runs WHERE status = 'running'`;
	return open.map(({ id, started_at }) => {
		const [last] = sql<{ at: number | null }>`
			SELECT max(coalesce(ended_at, started_at)) AS at FROM trace_spans WHERE run_id = ${id}`;
		const endedAt = Math.max(started_at, last?.at ?? started_at);
		return { runId: id, finish: closeRun(sql, id, "interrupted", null, endedAt) };
	});
}

/** A run's spans in order, or none when this conversation has no such run. */
export function readTrace(sql: Sql, runId: string): RunSpan[] {
	return sql<SpanRow>`
		SELECT id, step, status, started_at, ended_at, attributes FROM trace_spans
		WHERE run_id = ${runId} ORDER BY step`.map((row) => ({
		id: row.id,
		kind: "model",
		step: row.step,
		status: row.status,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		...(JSON.parse(row.attributes) as ModelAttributes),
	}));
}
