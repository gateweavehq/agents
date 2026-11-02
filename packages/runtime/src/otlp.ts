/**
 * A run's trace as OpenTelemetry spans, in OTLP/HTTP's JSON encoding, for the workspace's own
 * observability tool. Docs, checked 2026-11-02:
 * - https://opentelemetry.io/docs/specs/otlp/ (OTLP/HTTP: `POST /v1/traces`, JSON with ids in
 *   hex and times as nanoseconds in strings)
 * - https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/ and
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/ (`invoke_agent`,
 *   `chat` and `execute_tool` spans, and their `gen_ai.*` attributes)
 *
 * The run is one span, with its model requests, the MCP servers it connected to and the edges it
 * took under it, and the tools each request called under that request. A run a team's edge started
 * joins the trace of the run at the top, under the edge's span, so a team's turn reads as one
 * trace. Like the trace it comes from, it holds no message text and no tool input or output.
 */
import type { RunSpan, TotaledRun } from "@gateweave/agents-model";

/** What the export needs of the registry's record of a run. */
export type ExportedRun = Pick<
	TotaledRun,
	| "id"
	| "agentId"
	| "agentName"
	| "conversationId"
	| "provider"
	| "model"
	| "status"
	| "error"
	| "inputTokens"
	| "outputTokens"
	| "cachedInputTokens"
	| "cost"
	| "startedAt"
	| "endedAt"
	| "parentSpanId"
	| "rootRunId"
>;

type AnyValue =
	| { stringValue: string }
	| { intValue: string }
	| { doubleValue: number }
	| { boolValue: boolean }
	| { arrayValue: { values: AnyValue[] } };

interface KeyValue {
	key: string;
	value: AnyValue;
}

export interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	/** 1 internal, 3 client. */
	kind: 1 | 3;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: KeyValue[];
	/** 0 unset, 1 ok, 2 error. */
	status: { code: 0 | 1 | 2; message?: string };
}

export interface OtlpTraces {
	resourceSpans: {
		resource: { attributes: KeyValue[] };
		scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
	}[];
}

const SERVICE = "gateweave-agents";

/** The OTLP request body for one run. */
export function runTraces(workspaceId: string, run: ExportedRun, spans: RunSpan[]): OtlpTraces {
	const traceId = hexId(run.rootRunId ?? run.id, 16);
	const runSpanId = runSpanIdOf(run.id);
	const ended = run.endedAt ?? Math.max(run.startedAt, ...spans.map(endOf));
	const root: OtlpSpan = {
		traceId,
		spanId: runSpanId,
		...(run.parentSpanId ? { parentSpanId: spanIdOf(run.parentSpanId) } : {}),
		name: `invoke_agent ${run.agentName}`,
		kind: 1,
		startTimeUnixNano: nanos(run.startedAt),
		endTimeUnixNano: nanos(ended),
		attributes: attributes({
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.id": run.agentId,
			"gen_ai.agent.name": run.agentName,
			"gen_ai.conversation.id": run.conversationId,
			"gen_ai.provider.name": run.provider,
			"gen_ai.request.model": run.model,
			"gen_ai.usage.input_tokens": int(run.inputTokens),
			"gen_ai.usage.output_tokens": int(run.outputTokens),
			"gen_ai.usage.cache_read.input_tokens": int(run.cachedInputTokens),
			"gateweave.run.id": run.id,
			"gateweave.run.status": run.status,
			"gateweave.cost_usd": run.cost === null ? null : run.cost / 1_000_000,
		}),
		status: run.status === "succeeded" ? { code: 1 } : statusOf(run.status, run.error),
	};
	// Tools and edges belong to the model request that called them.
	const requests = new Map<number, string>();
	for (const span of spans) if (span.kind === "model") requests.set(span.step, spanIdOf(span.id));
	const children = spans.map((span): OtlpSpan => {
		const parentSpanId =
			span.kind === "tool" || span.kind === "edge"
				? (requests.get(span.step) ?? runSpanId)
				: runSpanId;
		const base = {
			traceId,
			spanId: spanIdOf(span.id),
			parentSpanId,
			startTimeUnixNano: nanos(span.startedAt),
			endTimeUnixNano: nanos(span.endedAt ?? ended),
			status:
				span.status === "ok"
					? { code: 1 as const }
					: span.status === "error"
						? { code: 2 as const, ...(span.error ? { message: span.error } : {}) }
						: { code: 0 as const },
		};
		switch (span.kind) {
			case "model":
				return {
					...base,
					name: `chat ${span.model}`,
					kind: 3,
					attributes: attributes({
						"gen_ai.operation.name": "chat",
						"gen_ai.provider.name": run.provider,
						"gen_ai.request.model": run.model,
						"gen_ai.response.model": span.model,
						"gen_ai.usage.input_tokens": int(span.inputTokens),
						"gen_ai.usage.output_tokens": int(span.outputTokens),
						"gen_ai.usage.cache_read.input_tokens": int(span.cachedInputTokens),
						"gen_ai.response.finish_reasons": span.finishReason ? [span.finishReason] : null,
						"gateweave.cost_usd": span.cost === null ? null : span.cost / 1_000_000,
						"gateweave.first_token_ms": span.firstTokenMs === null ? null : int(span.firstTokenMs),
						"gateweave.ai_gateway.log_id": span.gatewayLogId,
					}),
				};
			case "tool":
				return {
					...base,
					name: `execute_tool ${span.tool}`,
					kind: 1,
					attributes: attributes({
						"gen_ai.operation.name": "execute_tool",
						"gen_ai.tool.name": span.tool,
						"gateweave.tool.server": span.server,
						"gateweave.tool.input_bytes": int(span.inputBytes),
						"gateweave.tool.output_bytes": span.outputBytes === null ? null : int(span.outputBytes),
					}),
				};
			case "connect":
				return {
					...base,
					name: `connect ${span.server}`,
					kind: 3,
					attributes: attributes({
						"gateweave.mcp.server": span.server,
						"gateweave.mcp.tools": span.tools === null ? null : int(span.tools),
					}),
				};
			default:
				// An edge: the last kind.
				return {
					...base,
					name: `${span.edge} ${span.to}`,
					kind: 1,
					attributes: attributes({
						"gateweave.team.edge": span.edge,
						"gateweave.team.to": span.to,
						"gateweave.child_run.id": span.childRunId,
					}),
				};
		}
	});
	return {
		resourceSpans: [
			{
				resource: {
					attributes: attributes({
						"service.name": SERVICE,
						"gateweave.workspace.id": workspaceId,
					}),
				},
				scopeSpans: [{ scope: { name: SERVICE }, spans: [root, ...children] }],
			},
		],
	};
}

/** The run's own span: the half of its id the trace id, which comes from the run at the top, skips. */
export function runSpanIdOf(runId: string): string {
	return hexId(runId, 16).slice(16);
}

/** A span's id in OTLP: 8 bytes of its UUID. */
export function spanIdOf(id: string): string {
	return hexId(id, 8);
}

/**
 * `bytes` bytes of an id, in hex: those of a UUID as they are, and a hash of anything else, so an
 * id that is not one still maps to the same span every time.
 */
function hexId(id: string, bytes: 8 | 16): string {
	const hex = id.replace(/-/g, "").toLowerCase();
	if (/^[0-9a-f]{32}$/.test(hex)) return hex.slice(0, bytes * 2);
	let out = "";
	let hash = 0x811c9dc5;
	for (let round = 0; out.length < bytes * 2; round++) {
		for (const char of `${round}:${id}`) {
			hash ^= char.charCodeAt(0);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		out += hash.toString(16).padStart(8, "0");
	}
	return out.slice(0, bytes * 2);
}

function endOf(span: RunSpan): number {
	return span.endedAt ?? span.startedAt;
}

function statusOf(status: string, error: string | null): OtlpSpan["status"] {
	if (status === "running") return { code: 0 };
	return { code: 2, message: error ?? `The run was ${status}` };
}

function nanos(ms: number): string {
	return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/** A whole number, which OTLP's JSON carries as a string. */
class Int {
	constructor(readonly value: number) {}
}

function int(value: number): Int {
	return new Int(value);
}

type Attribute = string | number | boolean | Int | string[] | null;

/** The attributes that have a value, in OTLP's encoding. */
function attributes(values: Record<string, Attribute>): KeyValue[] {
	return Object.entries(values).flatMap(([key, value]): KeyValue[] =>
		value === null ? [] : [{ key, value: anyValue(value) }],
	);
}

function anyValue(value: Exclude<Attribute, null>): AnyValue {
	if (value instanceof Int) return { intValue: String(Math.round(value.value)) };
	if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => anyValue(item)) } };
	if (typeof value === "number") return { doubleValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	return { stringValue: value };
}
