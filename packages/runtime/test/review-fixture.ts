import { REVIEW_TOOL, type ReviewOutcome } from "@gateweave/agents-model";
import { vi } from "vitest";
import { type ReviewPort, reviewTools } from "../src/review";
import type { RunRecorder } from "../src/trace";
import { MemorySandbox } from "./fake-sandbox";

export const HEAD = "a".repeat(40);
export const MERGE_BASE = "b".repeat(40);
export const answer = (output = "", exitCode = 0, seconds = 0) => ({
	output,
	exitCode,
	seconds,
	timedOut: false,
});
export const finding = {
	path: "app.ts",
	line: 1,
	severity: "high",
	title: "Drops zero",
	failingCase: "Passing zero returns null",
	criterion: null,
	test: {
		path: "test/a.test.ts",
		content: "assert.equal(read(0), 0)",
		command: "pnpm vitest run test/a.test.ts",
	},
};

const DIFF = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1,3 +1 @@
 context
-deleted
-also deleted
diff --git a/old b/new
rename from old
rename to new
--- a/old
+++ b/new
@@ -5 +5 @@
-before
+after
`;

export function setup(port?: ReviewPort, supplied?: string) {
	const sandbox = new MemorySandbox();
	sandbox.gitAnswer = (args) =>
		args[0] === "merge-base"
			? answer(MERGE_BASE)
			: args.includes("diff")
				? answer(DIFF)
				: undefined;
	const run = { toolStarted: vi.fn(() => "span"), toolEnded: vi.fn() };
	const record = vi.fn(async (_outcome: ReviewOutcome) => {});
	const tools = reviewTools({
		sandbox: port ?? sandbox,
		base: "origin/main",
		diff: supplied,
		head: HEAD,
		run: run as unknown as RunRecorder,
		record,
		now: () => sandbox.clock,
	});
	async function call(findings: unknown[] = [finding]): Promise<ReviewOutcome> {
		const execute = tools[REVIEW_TOOL]?.execute;
		if (!execute) throw new Error("Missing submit_review");
		return (await execute(
			{ findings },
			{ toolCallId: "call", messages: [], context: undefined },
		)) as ReviewOutcome;
	}
	return { sandbox, run, tools, record, call };
}
