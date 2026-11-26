import { expect, it } from "vitest";
import { countWouldRefuse, isWouldRefuse, type RunSpan } from "../src";

it("counts flagged spans once and groups only those with a target", () => {
	const base = {
		id: "span",
		step: 0,
		startedAt: 1,
		endedAt: 2,
		status: "ok",
		error: null,
	} as const;
	const tool = {
		...base,
		kind: "tool",
		tool: "send",
		server: "test",
		inputBytes: 1,
		outputBytes: 1,
	} as const;
	const target = { kind: "email", host: "example.org", decision: "would_refuse" } as const;
	const cases: [RunSpan, boolean][] = [
		[
			{
				...base,
				kind: "model",
				model: "test",
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				cost: null,
				finishReason: null,
				firstTokenMs: null,
				gatewayLogId: null,
			},
			false,
		],
		[{ ...base, kind: "connect", status: "running", server: "test", tools: null }, false],
		[tool, false],
		[{ ...tool, target: { kind: "email", host: "example.org" } }, false],
		[{ ...tool, target }, true],
		[{ ...tool, target: { ...target, kind: "url" } }, true],
		[{ ...tool, target: { ...target, kind: "ip", host: "203.0.113.9" } }, true],
		[{ ...tool, status: "would_refuse" }, true],
		[{ ...tool, status: "would_refuse", target }, true],
		[{ ...tool, status: "refused", target }, false],
		[
			{ ...base, kind: "edge", status: "error", edge: "ask", to: "peer", childRunId: null, target },
			true,
		],
	];
	for (const [span, flagged] of cases) expect(isWouldRefuse(span)).toBe(flagged);
	const spans = cases.map(([span]) => span);
	const counts = countWouldRefuse(spans);
	expect(counts).toEqual({ total: 6, email: 3, url: 1, ip: 1 });
	expect(counts.total).toBe(spans.filter(isWouldRefuse).length);
});
