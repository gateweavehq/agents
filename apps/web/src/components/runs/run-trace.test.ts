import type { RunSpan, ToolSpan } from "@gateweave/agents-model";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunTrace } from "./run-trace";

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
	return renderToString(createElement(RunTrace, { trace })).replaceAll("<!-- -->", "");
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
