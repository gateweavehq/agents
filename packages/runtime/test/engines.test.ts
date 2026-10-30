import { describe, expect, it } from "vitest";
import {
	describeUnfinished,
	ENGINE_SECONDS,
	LOG_TAIL_LIMIT,
	LOG_TAIL_LINES,
	logTail,
} from "../src/engines";

describe("the end of an engine's log", () => {
	it("is its last lines, without blank ones", () => {
		const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, index) => `line ${index}`);
		const tail = logTail(`${lines.join("\n\n")}\n`);

		expect(tail.split("\n")).toEqual(lines.slice(-LOG_TAIL_LINES));
	});

	it("takes out anything like a key, whole or masked, before it is cut", () => {
		const log = [
			"Error: 401 Incorrect API key provided: sk-proj-abcd****wxyz.",
			"fetch failed with sk-ant-api03-secret-value",
		].join("\n");

		expect(logTail(log)).toBe(
			["Error: 401 Incorrect API key provided: [key]", "fetch failed with [key]"].join("\n"),
		);
	});

	it("keeps to its limit, from the end", () => {
		const tail = logTail(`${"a".repeat(LOG_TAIL_LIMIT)}the end`);

		expect(tail).toHaveLength(LOG_TAIL_LIMIT + 1);
		expect(tail.startsWith("…")).toBe(true);
		expect(tail.endsWith("the end")).toBe(true);
	});
});

describe("why an engine stopped without saying", () => {
	it("is unknown when the sandbox cannot tell", () => {
		expect(describeUnfinished("Codex", null)).toBe("Codex stopped before it finished.");
		expect(describeUnfinished("Codex", { code: null, seconds: 4, log: "" })).toBe(
			"Codex stopped before it finished.",
		);
	});

	it("is the turn's time when it ran out of it, stopped or killed", () => {
		const words = `Codex ran for ${ENGINE_SECONDS / 60} minutes, the most one message may take.`;

		expect(describeUnfinished("Codex", { code: 124, seconds: ENGINE_SECONDS, log: "" })).toBe(
			words,
		);
		expect(describeUnfinished("Codex", { code: 137, seconds: ENGINE_SECONDS + 30, log: "" })).toBe(
			words,
		);
	});

	it("is the sandbox's memory when it was killed sooner", () => {
		expect(describeUnfinished("OpenCode", { code: 137, seconds: 90, log: "ignored" })).toBe(
			"OpenCode was killed before it finished, most likely because the sandbox ran out of memory.",
		);
	});

	it("is its exit status and the end of its log otherwise", () => {
		expect(describeUnfinished("Claude Code", { code: 1, seconds: 2, log: "a\nb" })).toBe(
			"Claude Code stopped before it finished (exit status 1). The end of its log:\na\nb",
		);
		expect(describeUnfinished("Claude Code", { code: 0, seconds: 2, log: "" })).toBe(
			"Claude Code stopped before it finished (exit status 0).",
		);
	});
});
