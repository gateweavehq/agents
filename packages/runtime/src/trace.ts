/**
 * The trace of each run, kept in the conversation's own SQLite next to its messages: one span per
 * model request, with its timing, tokens, estimated cost and AI Gateway log id, one per call to a
 * tool, one per MCP server the turn connected to, and one per edge of a team it took, with the run
 * that started. The registry gets the sum when the run ends
 * (`RunFinish`); the trace stays here, private like the conversation, and goes when the
 * conversation is deleted.
 */
import {
	type AgentSnapshot,
	type ConnectSpan,
	type EdgeSpan,
	type ModelSpan,
	type RequestTokens,
	type RunFinish,
	type RunSpan,
	type RunStatus,
	requestCost,
	type TeamEdgeKind,
	type ToolSpan,
} from "@gateweave/agents-model";
import type { StepResult, ToolSet } from "ai";

type SqlValue = string | number | boolean | null;

/** The Agents SDK's `this.sql`: a synchronous query on the Durable Object's SQLite. */
export type Sql = <T = Record<string, SqlValue>>(
	strings: TemplateStringsArray,
	...values: SqlValue[]
) => T[];

type Base = "id" | "kind" | "step" | "status" | "startedAt" | "endedAt";

/** What each kind of span records besides its timing, as JSON in `attributes`. */
type ModelAttributes = Omit<ModelSpan, Base>;
type ToolAttributes = Omit<ToolSpan, Base>;
type ConnectAttributes = Omit<ConnectSpan, Base>;
type EdgeAttributes = Omit<EdgeSpan, Base>;

interface SpanRow {
	id: string;
	kind: RunSpan["kind"];
	step: number;
	status: RunSpan["status"];
	started_at: number;
	ended_at: number | null;
	attributes: string;
}

/** A model request that answered: the model, its tokens, and how it ended. */
export interface EndedRequest {
	model: string;
	tokens: RequestTokens;
	finishReason: string | null;
	firstTokenMs: number | null;
	gatewayLogId: string | null;
	/** Whether the tokens are several requests' together, which `requestCost` prices apart. */
	summed?: boolean;
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
	/** The model request under way, which the tools it calls belong to. */
	#step = 0;
	#finished = false;

	constructor(sql: Sql, runId: string, agent: AgentSnapshot, now = Date.now()) {
		this.#sql = sql;
		this.#agent = agent;
		this.runId = runId;
		sql`INSERT INTO trace_runs (id, status, started_at) VALUES (${runId}, 'running', ${now})`;
	}

	stepStarted(step: number, now = Date.now()): void {
		this.#step = step;
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
		this.#insert("model", step, attributes, now);
	}

	stepEnded(result: StepResult<ToolSet>, now = Date.now()): void {
		const { usage } = result;
		this.requestEnded(
			result.stepNumber,
			{
				model: result.response.modelId || this.#agent.model,
				tokens: {
					input: usage.inputTokens ?? 0,
					output: usage.outputTokens ?? 0,
					cacheRead: usage.inputTokenDetails.cacheReadTokens ?? 0,
					cacheWrite: usage.inputTokenDetails.cacheWriteTokens ?? 0,
				},
				finishReason: result.finishReason,
				firstTokenMs:
					result.performance.timeToFirstOutputMs === undefined
						? null
						: Math.round(result.performance.timeToFirstOutputMs),
				gatewayLogId: result.response.headers?.[GATEWAY_LOG_ID] ?? null,
			},
			now,
		);
	}

	/**
	 * A model request that answered, however the turn made it: through the AI SDK (`stepEnded`), or
	 * as an engine in the sandbox reports it (`./engines.ts`).
	 */
	requestEnded(step: number, request: EndedRequest, now = Date.now()): void {
		const { model, tokens } = request;
		const { provider } = this.#agent;
		const attributes: ModelAttributes = {
			model,
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			cachedInputTokens: tokens.cacheRead,
			cost:
				requestCost(provider, model, tokens, now, request.summed) ??
				requestCost(provider, this.#agent.model, tokens, now, request.summed),
			finishReason: request.finishReason,
			firstTokenMs: request.firstTokenMs,
			gatewayLogId: request.gatewayLogId,
			error: null,
		};
		this.#endStep(step, request.finishReason === "error" ? "error" : "ok", attributes, now);
	}

	/** A request that failed before the model answered, with why in the app's words. */
	stepFailed(step: number, error: string, now = Date.now()): void {
		this.#endStep(step, "error", { error }, now);
	}

	/** Starts connecting to an MCP server. Returns the span's id. */
	serverConnecting(server: string, now = Date.now()): string {
		const attributes: ConnectAttributes = { server, tools: null, error: null };
		return this.#insert("connect", 0, attributes, now);
	}

	serverConnected(span: string, tools: number, now = Date.now()): void {
		this.#end(span, "ok", { tools }, now);
	}

	serverFailed(span: string, error: string, now = Date.now()): void {
		this.#end(span, "error", { error }, now);
	}

	/** A server the turn goes on without, as `problem` says, before trying to connect. */
	serverLeftOut(server: string, problem: string, now = Date.now()): void {
		this.serverFailed(this.serverConnecting(server, now), problem, now);
	}

	/** Starts a call to a tool, in the model request under way. Returns the span's id. */
	toolStarted(server: string, tool: string, inputBytes: number, now = Date.now()): string {
		const attributes: ToolAttributes = { server, tool, inputBytes, outputBytes: null, error: null };
		return this.#insert("tool", this.#step, attributes, now);
	}

	toolEnded(
		span: string,
		outcome: { outputBytes: number; error: string | null } | { error: string },
		now = Date.now(),
	): void {
		this.#end(span, outcome.error === null ? "ok" : "error", outcome, now);
	}

	/** Starts a call over a team's edge, in the model request under way. Returns the span's id. */
	edgeStarted(edge: TeamEdgeKind, to: string, now = Date.now()): string {
		const attributes: EdgeAttributes = { edge, to, childRunId: null, error: null };
		return this.#insert("edge", this.#step, attributes, now);
	}

	/** Ends a call over an edge, with the run it started, and why it failed when it did. */
	edgeEnded(
		span: string,
		outcome: { childRunId: string | null; error: string | null },
		now = Date.now(),
	): void {
		this.#end(span, outcome.error === null ? "ok" : "error", outcome, now);
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
		const [span] = this.#sql<{ id: string }>`
			SELECT id FROM trace_spans WHERE run_id = ${this.runId} AND kind = 'model' AND step = ${step}`;
		if (span) this.#end(span.id, status, attributes, now);
	}

	#insert(kind: RunSpan["kind"], step: number, attributes: object, now: number): string {
		const id = crypto.randomUUID();
		this.#sql`INSERT INTO trace_spans (id, run_id, kind, step, status, started_at, attributes)
			VALUES (${id}, ${this.runId}, ${kind}, ${step}, 'running', ${now},
				${JSON.stringify(attributes)})`;
		return id;
	}

	/** Ends a span, merging `attributes` into what it recorded. */
	#end(id: string, status: "ok" | "error", attributes: object, now: number): void {
		const [span] = this.#sql<{ attributes: string }>`
			SELECT attributes FROM trace_spans WHERE id = ${id}`;
		if (!span) return;
		const merged = { ...(JSON.parse(span.attributes) as object), ...attributes };
		this.#sql`UPDATE trace_spans
			SET status = ${status}, ended_at = ${now}, attributes = ${JSON.stringify(merged)}
			WHERE id = ${id}`;
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
	// Only model requests use tokens and cost money.
	const spans = readTrace(sql, runId).filter((span) => span.kind === "model");
	const sum = (pick: (span: ModelSpan) => number) =>
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

/**
 * A run's spans in order, or none when this conversation has no such run: by model request, and
 * within one, connecting first, then the request, then the tools it called and the edges it took.
 */
export function readTrace(sql: Sql, runId: string): RunSpan[] {
	return sql<SpanRow>`
		SELECT id, kind, step, status, started_at, ended_at, attributes FROM trace_spans
		WHERE run_id = ${runId}
		ORDER BY step, CASE kind WHEN 'connect' THEN 0 WHEN 'model' THEN 1 ELSE 2 END, started_at`.map(
		(row) =>
			({
				id: row.id,
				kind: row.kind,
				step: row.step,
				status: row.status,
				startedAt: row.started_at,
				endedAt: row.ended_at,
				// Written by this module only, in the shape of the span's kind.
				...JSON.parse(row.attributes),
			}) as RunSpan,
	);
}
