import { describe, expect, it } from "vitest";
import { turnProgressOf } from "./turn-progress";

describe("turnProgressOf", () => {
	it("reads the label of a progress part", () => {
		expect(
			turnProgressOf({
				type: "data-progress",
				data: { label: "Checking out the repository" },
				transient: true,
			}),
		).toBe("Checking out the repository");
	});

	it("reads a part that clears the line as null", () => {
		expect(
			turnProgressOf({ type: "data-progress", data: { label: null }, transient: true }),
		).toBeNull();
	});

	it("ignores every other chunk", () => {
		expect(turnProgressOf({ type: "data-run", data: { runId: "run-1" } })).toBeUndefined();
		expect(turnProgressOf({ type: "text-delta", delta: "hi" })).toBeUndefined();
		expect(turnProgressOf({ type: "data-progress", data: "not an object" })).toBeUndefined();
		expect(turnProgressOf({ type: "data-progress", data: { label: 42 } })).toBeNull();
		expect(turnProgressOf(null)).toBeUndefined();
		expect(turnProgressOf("data-progress")).toBeUndefined();
	});
});
