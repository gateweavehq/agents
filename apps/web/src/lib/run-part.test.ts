import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { runIdOf } from "./run-part";

function message(parts: UIMessage["parts"]): UIMessage {
	return { id: "m1", role: "assistant", parts };
}

describe("runIdOf", () => {
	it("reads the run a reply's part names", () => {
		expect(runIdOf(message([{ type: "data-run", data: { runId: "run-1" } }]))).toBe("run-1");
	});

	it("finds the part among the reply's others", () => {
		expect(
			runIdOf(
				message([
					{ type: "text", text: "Done." },
					{ type: "data-run", data: { runId: "run-2" } },
				]),
			),
		).toBe("run-2");
	});

	it("has none for a reply without the part or with a malformed one", () => {
		expect(runIdOf(message([{ type: "text", text: "Done." }]))).toBeNull();
		expect(runIdOf(message([{ type: "data-run", data: "run-3" }]))).toBeNull();
		expect(runIdOf(message([{ type: "data-run", data: { runId: 42 } }]))).toBeNull();
		expect(runIdOf(message([{ type: "data-run", data: {} }]))).toBeNull();
	});
});
