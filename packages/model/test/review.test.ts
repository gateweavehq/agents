import { describe, expect, it } from "vitest";
import { REVIEW_LIMITS, reviewFinding, reviewInput, reviewMessage } from "../src";

const finding = {
	severity: "high",
	path: "a.ts",
	line: 1,
	title: "Drops zero",
	failingCase: "Passing 0 returns null",
	criterion: null,
	test: {
		path: "test/a.test.ts",
		content: "assert.equal(read(0), 0)",
		command: "node test/a.test.ts",
	},
};

describe("a review submission", () => {
	it("accepts a complete finding and a clean review", () => {
		expect(reviewFinding.parse(finding)).toEqual({ ...finding, side: "RIGHT" });
		expect(reviewInput.parse({ findings: [] })).toEqual({ findings: [] });
	});
	it.each([
		["path", undefined],
		["path", ""],
		["line", undefined],
		["line", 0],
		["line", 1.5],
		["failingCase", undefined],
		["failingCase", ""],
		["severity", undefined],
		["severity", "urgent"],
	])("rejects %s set to %s", (key, value) => {
		expect(reviewFinding.safeParse({ ...finding, [String(key)]: value }).success).toBe(false);
	});
	it("accepts twenty findings and refuses twenty-one", () => {
		expect(reviewInput.safeParse({ findings: Array(20).fill(finding) }).success).toBe(true);
		expect(reviewInput.safeParse({ findings: Array(21).fill(finding) }).success).toBe(false);
	});
	const acceptsCommand = (command: string) =>
		reviewFinding.safeParse({ ...finding, test: { ...finding.test, command } }).success;
	it("accepts a 300-character command and refuses 301", () => {
		expect(acceptsCommand("x".repeat(300))).toBe(true);
		expect(acceptsCommand("x".repeat(301))).toBe(false);
	});
	it.each(["", "x\ny", "x\ty", "x\x1by", "x\u2028y"])(
		"refuses an empty or multiline command %j",
		(command) => {
			expect(acceptsCommand(command)).toBe(false);
		},
	);
	it("reads an omitted test or criterion as null and keeps its sibling findings", () => {
		const { test: _test, criterion: _criterion, ...incomplete } = finding;
		expect(reviewFinding.parse(incomplete)).toMatchObject({ test: null, criterion: null });
		const { findings } = reviewInput.parse({ findings: [incomplete, finding] });
		expect(findings.map((f) => f.test)).toEqual([null, finding.test]);
	});
	it("still refuses a test that is present but incomplete", () => {
		expect(() => reviewFinding.parse({ ...finding, test: { path: "test/a.test.ts" } })).toThrow();
	});
	it("strips a submitted proof claim", () => {
		expect(reviewFinding.parse({ ...finding, proven: true })).not.toHaveProperty("proven");
	});
});

describe("the review message", () => {
	it("numbers criteria and fences a diff containing backticks", () => {
		const diff = "+before\n`````\n+after";
		expect(reviewMessage(diff, ["First", "Second"])).toContain(
			["1. First", "2. Second", "", "Diff", "``````diff", diff, "``````"].join("\n"),
		);
	});
	it("sizes the fence from the patch that is sent, not from what was left out", () => {
		const kept = "a".repeat(REVIEW_LIMITS.diffBytes - 2);
		const omitted = `+${"`".repeat(2_000_000)}\n`;
		const message = reviewMessage(`${kept}\n${omitted}`, []);
		expect(message).toContain("```diff\n");
		expect(message.length).toBeLessThan(REVIEW_LIMITS.diffBytes + 1_000);
	});
	it("meets a long run of backticks in the patch with tildes", () => {
		const diff = `+${"`".repeat(40)}\n`;
		const message = reviewMessage(diff, []);
		expect(message).toContain(`~~~diff\n${diff}~~~`);
		expect(message).not.toContain("~~~~");
	});
	it("asks for correctness only when there are no criteria", () => {
		expect(reviewMessage("", [])).toContain("None. Review for correctness only.");
	});
	it("cuts at the previous complete line and counts omitted UTF-8 bytes", () => {
		const first = "a".repeat(REVIEW_LIMITS.diffBytes - 2);
		const message = reviewMessage(`${first}\né\nlast`, []);
		expect(message).toContain(`${first}\n[7 bytes left out]\n`);
		expect(message).not.toContain("�");
	});
});
