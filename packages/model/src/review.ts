import { z } from "zod";
import { CHECK_LIMITS, checkCommand } from "./checks";

export const REVIEW_TOOL = "submit_review";
export const REVIEW_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const REVIEW_LIMITS = {
	findings: 20,
	proofs: 8,
	proofSeconds: 5 * 60,
	totalProofSeconds: 15 * 60,
	outputBytes: CHECK_LIMITS.outputBytes,
	diffBytes: 200_000,
	title: 200,
	failingCase: 4_000,
	criterion: 500,
	testContent: 100_000,
	testPath: 300,
} as const;

export const reviewTest = z.object({
	path: z.string().trim().min(1).max(REVIEW_LIMITS.testPath),
	content: z.string().max(REVIEW_LIMITS.testContent),
	command: checkCommand,
});

export const reviewFinding = z
	.object({
		severity: z.enum(REVIEW_SEVERITIES),
		path: z
			.string()
			.min(1)
			.refine((path) => !path.startsWith("./"), "Use a repository path without ./"),
		line: z.number().int().positive(),
		side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
		title: z.string().trim().min(1).max(REVIEW_LIMITS.title),
		failingCase: z.string().trim().min(1).max(REVIEW_LIMITS.failingCase),
		criterion: z.string().max(REVIEW_LIMITS.criterion).nullable(),
		test: reviewTest.nullable(),
	})
	// An empty schema accepts extra keys in the MCP catalog. Zod strips them on input.
	.meta({ additionalProperties: {} });

export const reviewInput = z.object({
	findings: z.array(reviewFinding).max(REVIEW_LIMITS.findings),
});
export type ReviewFinding = z.output<typeof reviewFinding>;
export type ReviewInput = z.output<typeof reviewInput>;
export type ReviewProof =
	| { proven: true; exitCode: number; output: string }
	| { proven: false; reason: string; exitCode?: number; output?: string };
export interface ReviewedFinding extends ReviewFinding {
	offDiff: boolean;
	proof: ReviewProof;
}
export interface ReviewOutcome {
	findings: ReviewedFinding[];
	proofsRun: number;
	proofSeconds: number;
}

export const REVIEW_INSTRUCTIONS = `Review the branch diff against the acceptance criteria and for correctness.
Report only defects with a concrete failing case. Give the input and what goes wrong.
Leave out matters of style. Submit one finding per defect, most severe first.
Give its repository path and line number. Use RIGHT for added or context lines,
and LEFT for a deleted line. Name the criterion it breaks, if any.
For a defect a test can show, propose a new file under the repository's test folders.
Supply its full content and one command line that runs only that file.
The test should fail while the defect exists.
${REVIEW_TOOL} runs the test at the reviewed head and decides whether the finding is proven.
Never claim a finding is proven yourself.
Call ${REVIEW_TOOL} exactly once with at most ${REVIEW_LIMITS.findings} findings.
Submit an empty list if there is nothing to report.`;

export function reviewMessage(diff: string, criteria: readonly string[]): string {
	const bytes = new TextEncoder().encode(diff);
	let patch = diff;
	if (bytes.length > REVIEW_LIMITS.diffBytes) {
		const end = bytes.lastIndexOf(10, REVIEW_LIMITS.diffBytes - 1) + 1;
		patch = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(
			bytes.subarray(0, end),
		);
		patch += `[${bytes.length - end} bytes left out]`;
	}
	let length = 3;
	for (const [ticks] of diff.matchAll(/`+/g)) length = Math.max(length, ticks.length + 1);
	const fence = "`".repeat(length);
	const list = criteria.length
		? criteria.map((item, i) => `${i + 1}. ${item}`).join("\n")
		: "None. Review for correctness only.";
	return `Acceptance criteria\n${list}\n\nDiff\n${fence}diff\n${patch}${patch.endsWith("\n") ? "" : "\n"}${fence}`;
}
