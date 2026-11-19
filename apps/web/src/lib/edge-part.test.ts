import type { ToolUIPart, UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { edgeRunsOf } from "./edge-part";

function message(parts: UIMessage["parts"]): UIMessage {
	return { id: "m1", role: "assistant", parts };
}

/** An edge call as an engine's chat shows it: the engine's own id, name and input. */
function edgeCall(toolCallId: string, type: string, input: object): ToolUIPart {
	return {
		type,
		toolCallId,
		state: "output-available",
		input,
		output: "It is done.",
	} as ToolUIPart;
}

describe("edgeRunsOf", () => {
	it("reads the run each edge call started", () => {
		const runs = edgeRunsOf(
			message([
				{ type: "text", text: "Delegating." },
				{ type: "data-edge", data: { toolCallId: "call-1", runId: "run-1" } },
				{ type: "data-edge", data: { toolCallId: "call-2", runId: "run-2" } },
			]),
		);
		expect(runs.get("call-1")).toBe("run-1");
		expect(runs.get("call-2")).toBe("run-2");
	});

	it("finds the parts among the message's other parts", () => {
		const runs = edgeRunsOf(
			message([
				{ type: "data-run", data: { runId: "run-0" } },
				{ type: "text", text: "Done." },
				{ type: "data-edge", data: { toolCallId: "call-1", runId: "run-1" } },
			]),
		);
		expect([...runs.entries()]).toEqual([["call-1", "run-1"]]);
	});

	it("answers nothing for messages without the parts, or with malformed ones", () => {
		expect(edgeRunsOf(message([{ type: "text", text: "Hi" }])).size).toBe(0);
		expect(
			edgeRunsOf(
				message([
					{ type: "data-edge", data: { toolCallId: "call-1" } },
					{ type: "data-edge", data: { runId: "run-2" } },
					{ type: "data-edge", data: { toolCallId: 42, runId: "run-3" } },
					{ type: "data-edge", data: { toolCallId: "call-4", runId: "" } },
					{ type: "data-edge", data: "run-5" },
				]),
			).size,
		).toBe(0);
	});

	it("finds an engine's call by the tool's name and text, as its chat names it", () => {
		const runs = edgeRunsOf(
			message([
				edgeCall("call-9", "tool-delegate__Coder", { task: "Fix the flaky test" }),
				{
					type: "data-edge",
					data: { toolName: "delegate__Coder", text: "Fix the flaky test", runId: "run-9" },
				},
			]),
		);
		expect([...runs.entries()]).toEqual([["call-9", "run-9"]]);
	});

	it("knows the text of each kind of edge: a question, a message, a task", () => {
		const runs = edgeRunsOf(
			message([
				edgeCall("call-1", "tool-ask__Analyst", { question: "What broke?" }),
				edgeCall("call-2", "tool-report__Lead", { message: "Heads up" }),
				{
					type: "data-edge",
					data: { toolName: "ask__Analyst", text: "What broke?", runId: "run-1" },
				},
				{ type: "data-edge", data: { toolName: "report__Lead", text: "Heads up", runId: "run-2" } },
			]),
		);
		expect(runs.get("call-1")).toBe("run-1");
		expect(runs.get("call-2")).toBe("run-2");
	});

	it("matches neither a call with other words nor a tool that is no edge", () => {
		const runs = edgeRunsOf(
			message([
				edgeCall("call-1", "tool-delegate__Coder", { task: "Fix it" }),
				edgeCall("call-2", "tool-acme__search", { query: "Fix it" }),
				{
					type: "data-edge",
					data: { toolName: "delegate__Coder", text: "Fix something else", runId: "run-1" },
				},
				{ type: "data-edge", data: { toolName: "acme__search", text: "Fix it", runId: "run-2" } },
			]),
		);
		expect(runs.size).toBe(0);
	});

	it("gives no call a link when two calls carry the same words", () => {
		const runs = edgeRunsOf(
			message([
				edgeCall("call-1", "tool-delegate__Coder", { task: "Fix it" }),
				edgeCall("call-2", "tool-delegate__Coder", { task: "Fix it" }),
				{
					type: "data-edge",
					data: { toolName: "delegate__Coder", text: "Fix it", runId: "run-1" },
				},
				{
					type: "data-edge",
					data: { toolName: "delegate__Coder", text: "Fix it", runId: "run-2" },
				},
			]),
		);
		expect(runs.size).toBe(0);
	});

	it("reads calls of both loops in one message", () => {
		const runs = edgeRunsOf(
			message([
				{ type: "data-edge", data: { toolCallId: "call-1", runId: "run-1" } },
				edgeCall("call-9", "tool-delegate__Coder", { task: "Fix it" }),
				{
					type: "data-edge",
					data: { toolName: "delegate__Coder", text: "Fix it", runId: "run-9" },
				},
			]),
		);
		expect(runs.get("call-1")).toBe("run-1");
		expect(runs.get("call-9")).toBe("run-9");
	});
});
