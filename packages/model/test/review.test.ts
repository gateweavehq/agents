import { describe, expect, it, vi } from "vitest";
import {
	REVIEW_LIMITS,
	type ReviewedFinding,
	type ReviewProof,
	rankFindings,
	reviewFinding,
	reviewInput,
	reviewMessage,
} from "../src";

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

describe("rankFindings", () => {
	const proven = { proven: true, exitCode: 1, output: "Assertion failed" } satisfies ReviewProof;
	const unproven = { proven: false, reason: "No proof ran" } satisfies ReviewProof;
	const reviewed = (overrides: Partial<ReviewedFinding> = {}): ReviewedFinding => ({
		...finding,
		severity: "medium",
		side: "RIGHT",
		offDiff: true,
		proof: unproven,
		...overrides,
	});

	const precedence = [
		{
			name: "severity beats proof",
			first: { proof: proven },
			second: { severity: "high" },
		},
		{
			name: "severity beats diff location",
			first: { offDiff: false },
			second: { severity: "high" },
		},
		{
			name: "severity beats model order",
			first: {},
			second: { severity: "high" },
		},
		{
			name: "proof beats diff location when severity ties",
			first: { offDiff: false },
			second: { proof: proven },
		},
		{
			name: "proof beats model order when severity ties",
			first: {},
			second: { proof: proven },
		},
		{
			name: "diff location beats model order when severity and proof tie",
			first: {},
			second: { offDiff: false },
		},
	] satisfies { name: string; first: Partial<ReviewedFinding>; second: Partial<ReviewedFinding> }[];

	it.each(precedence)("$name", ({ first, second }) => {
		const earlier = reviewed(first);
		const later = reviewed({ line: 2, ...second });
		expect(rankFindings([earlier, later]).shown).toEqual([later, earlier]);
	});

	it("uses model order when severity, proof and diff location tie", () => {
		const earlier = reviewed({ line: 2 });
		const later = reviewed();
		expect(rankFindings([earlier, later]).shown).toEqual([earlier, later]);
		expect(rankFindings([later, earlier]).shown).toEqual([later, earlier]);
	});

	it("keeps model order even when the sort reverses equal entries", () => {
		const earlier = reviewed({ line: 2 });
		const later = reviewed();
		const sort = Array.prototype.sort;
		// Native sort is stable, so reverse its input to expose a missing index tiebreak.
		const unstableSort = vi.spyOn(Array.prototype, "sort").mockImplementationOnce(function (
			this: unknown[],
			compare,
		) {
			return sort.call(this.reverse(), compare);
		});
		let result: ReturnType<typeof rankFindings>;
		try {
			result = rankFindings([earlier, later]);
		} finally {
			unstableSort.mockRestore();
		}
		expect(result.shown).toEqual([earlier, later]);
	});

	const ranked = [
		reviewed({ line: 1, severity: "critical", offDiff: false }),
		reviewed({ line: 2, severity: "high", proof: proven, offDiff: false }),
		reviewed({ line: 3, severity: "high", proof: proven }),
		reviewed({ line: 4, severity: "high", offDiff: false }),
		reviewed({ line: 5, severity: "medium", proof: proven, offDiff: false }),
		reviewed({ line: 6, severity: "medium", proof: proven }),
		reviewed({ line: 7, severity: "low", offDiff: false }),
	];

	it("shows the top five and collapses the remaining two in rank order", () => {
		expect(REVIEW_LIMITS.shown).toBe(5);
		expect(rankFindings([...ranked].reverse())).toEqual({
			shown: ranked.slice(0, 5),
			collapsed: ranked.slice(5),
		});
	});

	it.each([0, 4, 5])("collapses nothing with %i findings", (count) => {
		const subset = ranked.slice(0, count);
		expect(rankFindings([...subset].reverse())).toEqual({ shown: subset, collapsed: [] });
	});

	it("merges exact duplicates at the first position and keeps other locations or titles separate", () => {
		const first = Object.freeze(reviewed());
		const byTitle = reviewed({ title: "Other defect", severity: "high", proof: proven });
		const byLine = reviewed({ line: 2 });
		const byPath = reviewed({ path: "A.ts" });
		const duplicate = Object.freeze(
			reviewed({
				severity: "high",
				proof: proven,
				side: "LEFT",
				failingCase: "A second description",
			}),
		);
		expect(rankFindings([first, byTitle, byLine, duplicate, byPath])).toEqual({
			shown: [{ ...first, severity: "high", proof: proven }, byTitle, byLine, byPath],
			collapsed: [],
		});
	});

	it.each([false, true])("keeps the first proof when both have proven = %s", (isProven) => {
		const proof = isProven ? proven : unproven;
		const otherProof = isProven
			? { ...proven, output: "Another failure" }
			: { ...unproven, reason: "Skipped" };
		const first = reviewed({ proof, severity: "high", offDiff: true });
		const duplicate = reviewed({ proof: otherProof, offDiff: false });
		for (const pair of [
			[first, duplicate],
			[duplicate, first],
		] as const) {
			const [earliest] = pair;
			expect(rankFindings(pair)).toEqual({
				shown: [{ ...earliest, severity: "high", offDiff: false }],
				collapsed: [],
			});
		}
	});

	it("keeps side and offDiff of the same duplicate when their sides differ", () => {
		const offDiff = reviewed({ side: "RIGHT", offDiff: true });
		const onDiff = reviewed({ side: "LEFT", offDiff: false });
		for (const pair of [
			[offDiff, onDiff],
			[onDiff, offDiff],
		] as const) {
			expect(rankFindings(pair)).toEqual({
				shown: [{ ...onDiff }],
				collapsed: [],
			});
		}
	});

	it.each([7, 19, 42, 83])(
		"ranks findings with distinct severity, proof and diff-location combinations after shuffling with seed %i",
		(seed) => {
			const remaining = [...ranked];
			const shuffled: ReviewedFinding[] = [];
			let state = seed;
			while (remaining.length > 0) {
				state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
				shuffled.push(...remaining.splice(state % remaining.length, 1));
			}
			const snapshot = [...shuffled];
			expect(rankFindings(Object.freeze(shuffled))).toEqual(rankFindings(ranked));
			expect(shuffled).toEqual(snapshot);
		},
	);
});
