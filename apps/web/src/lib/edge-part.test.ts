import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { edgeRunsOf } from "./edge-part";

function message(parts: UIMessage["parts"]): UIMessage {
	return { id: "m1", role: "assistant", parts };
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
});
