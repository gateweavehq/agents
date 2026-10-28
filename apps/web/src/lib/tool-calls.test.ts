import type { DynamicToolUIPart } from "ai";
import { expect, it } from "vitest";
import { describeToolCall } from "./tool-calls";

const call = { type: "dynamic-tool", toolCallId: "call-1", input: { query: "flaky" } } as const;

it("names the server and the tool, and says how the call went", () => {
	const parts: DynamicToolUIPart[] = [
		{ ...call, toolName: "acme__search", state: "input-available" },
		{ ...call, toolName: "acme__search", state: "output-available", output: { content: [] } },
		{
			...call,
			toolName: "acme__search",
			state: "output-available",
			output: { content: [], isError: true },
		},
		{ ...call, toolName: "acme__search", state: "output-error", errorText: "Failed" },
		{ ...call, toolName: "search", state: "output-available", output: "plain" },
	];
	expect(parts.map(describeToolCall)).toEqual([
		{ server: "acme", tool: "search", state: "running" },
		{ server: "acme", tool: "search", state: "done" },
		{ server: "acme", tool: "search", state: "failed" },
		{ server: "acme", tool: "search", state: "failed" },
		{ server: null, tool: "search", state: "done" },
	]);
});
