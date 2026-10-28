import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import { expect, it } from "vitest";
import { describeEdgeCall, describeToolCall, toolCallsOf } from "./tool-calls";

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

it("finds the calls in a message the conversation stored, as well as in one streaming in", () => {
	// The conversation stores every call as a static part named after its tool, MCP tools too.
	const stored = {
		type: "tool-acme__search",
		toolCallId: "call-1",
		toolName: "acme__search",
		state: "output-available",
		input: { query: "flaky" },
		output: { content: [] },
	} as ToolUIPart;
	const live = { ...call, toolName: "acme__search", state: "input-available" } as DynamicToolUIPart;
	const message = (parts: UIMessage["parts"]): UIMessage => ({ id: "m", role: "assistant", parts });

	expect(
		toolCallsOf(message([{ type: "step-start" }, stored, { type: "text", text: "Found it." }])),
	).toEqual([stored]);
	expect(toolCallsOf(message([live]))).toEqual([live]);
	expect(describeToolCall(stored)).toEqual({ server: "acme", tool: "search", state: "done" });
});

it("shows a call over a team's edge as its kind and the member it went to", () => {
	const members = ["Planner", "Code reviewer", "QA"];
	const edge = (type: string, state: object) =>
		({ type, toolCallId: "call-2", input: { task: "Review it" }, ...state }) as ToolUIPart;
	expect(
		describeEdgeCall(edge("tool-delegate__Code_reviewer", { state: "input-available" }), members),
	).toEqual({ edge: "delegate", member: "Code reviewer", state: "running", error: null });
	expect(
		describeEdgeCall(
			edge("tool-ask__QA", { state: "output-available", output: "It passes." }),
			members,
		),
	).toEqual({ edge: "ask", member: "QA", state: "done", error: null });
	expect(
		describeEdgeCall(
			edge("tool-report__QA", {
				state: "output-error",
				errorText: "That edge is no longer in the team",
			}),
			members,
		),
	).toEqual({
		edge: "report",
		member: "QA",
		state: "failed",
		error: "That edge is no longer in the team",
	});
	expect(describeEdgeCall(edge("tool-acme__search", { state: "input-available" }), members)).toBe(
		null,
	);
});
