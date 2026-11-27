import type { RunSpan, ToolSpan } from "@gateweave/agents-model";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEntry } from "#/lib/runs";
import { Trace } from "./$workspace/runs.$runId";

const run: RunEntry = {
	id: "run",
	agentId: "agent",
	agentName: "Coder",
	conversationId: "conversation",
	startedBy: "user",
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	status: "succeeded",
	error: null,
	steps: 1,
	inputTokens: 10,
	outputTokens: 5,
	cachedInputTokens: 0,
	cost: 70,
	sandboxSeconds: null,
	startedAt: 0,
	endedAt: 1_000,
	parentRunId: null,
	parentSpanId: null,
	rootRunId: null,
	edge: null,
	depth: 0,
	teamPath: null,
	triggerId: null,
	triggerName: null,
	pullRequest: null,
	replayOf: null,
	total: {
		runs: 1,
		inputTokens: 10,
		outputTokens: 5,
		cost: 70,
		unpriced: 0,
		running: 0,
		sandboxSeconds: 0,
		sandboxCost: 0,
	},
	startedByName: "Ada",
};

function tool(span: Partial<ToolSpan> & Pick<ToolSpan, "id">): RunSpan {
	return {
		kind: "tool",
		server: "web",
		tool: "fetch",
		step: 0,
		status: "ok",
		startedAt: 100,
		endedAt: 200,
		error: null,
		inputBytes: 0,
		outputBytes: 0,
		...span,
	};
}

function render(trace: RunSpan[]) {
	return renderToString(createElement(Trace, { run, trace, nested: [] })).replaceAll(
		"<!-- -->",
		"",
	);
}

describe("the run trace's target-rule banner", () => {
	it("counts spans the rule would refuse, however they were flagged", () => {
		const html = render([
			tool({ id: "status", status: "would_refuse" }),
			tool({
				id: "decision",
				target: { kind: "url", host: "example.com", decision: "would_refuse" },
			}),
		]);
		expect(html).toContain("2 calls would be refused by the target rule.");
		expect(html).toContain(
			"After receiving outside content, the agent used a target without a trusted source.",
		);
	});

	it("does not show for a trace without flagged spans", () => {
		const html = render([tool({ id: "plain" })]);
		expect(html).not.toContain("would be refused by the target rule");
		expect(html).not.toContain(
			"After receiving outside content, the agent used a target without a trusted source.",
		);
	});
});
