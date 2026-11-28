import { z } from "zod";
import { CHECK_LIMITS, checkCommand } from "./checks";

export const REVIEW_TOOL = "submit_review";
export const REVIEW_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const REVIEW_LIMITS = {
	findings: 20,
	shown: 5,
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

/**
 * The ship gate for the review agent, measured by `scripts/review-replay` on the replay set. A run
 * passes when it finds at least `hits` of the `rows` defects and at least `realShare` of all its
 * findings are real. The bar was set before anything was measured.
 */
export const REVIEW_GATE = {
	bar: { rows: 35, hits: 12, realShare: 0.5 },
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
		// An omitted value is the same as null, so one incomplete finding does not refuse the rest.
		criterion: z.string().max(REVIEW_LIMITS.criterion).nullable().default(null),
		test: reviewTest.nullable().default(null),
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

export function rankFindings(findings: readonly ReviewedFinding[]): {
	shown: ReviewedFinding[];
	collapsed: ReviewedFinding[];
} {
	const merged = new Map<string, { finding: ReviewedFinding; index: number }>();
	findings.forEach((finding, index) => {
		const key = JSON.stringify([finding.path, finding.line, finding.title]);
		const entry = merged.get(key);
		if (!entry) {
			merged.set(key, { finding, index });
			return;
		}

		const first = entry.finding;
		entry.finding = {
			...first,
			severity:
				REVIEW_SEVERITIES.indexOf(finding.severity) < REVIEW_SEVERITIES.indexOf(first.severity)
					? finding.severity
					: first.severity,
			proof: first.proof.proven || !finding.proof.proven ? first.proof : finding.proof,
			// Side and offDiff describe one location: an on-diff duplicate brings its side along.
			...(first.offDiff && !finding.offDiff ? { side: finding.side, offDiff: false } : {}),
		};
	});

	const ranked = [...merged.values()]
		.sort(
			(a, b) =>
				REVIEW_SEVERITIES.indexOf(a.finding.severity) -
					REVIEW_SEVERITIES.indexOf(b.finding.severity) ||
				Number(b.finding.proof.proven) - Number(a.finding.proof.proven) ||
				Number(a.finding.offDiff) - Number(b.finding.offDiff) ||
				a.index - b.index,
		)
		.map(({ finding }) => finding);
	return {
		shown: ranked.slice(0, REVIEW_LIMITS.shown),
		collapsed: ranked.slice(REVIEW_LIMITS.shown),
	};
}

export interface ReviewOutcome {
	findings: ReviewedFinding[];
	proofsRun: number;
	proofSeconds: number;
	/**
	 * Set when the checkout could not be put back at the reviewed head, or a proof's command did
	 * not return in time, or left a process running, which may still use it. No later proof ran.
	 * The tool has asked the sandbox to discard the checkout; whoever holds it must not reuse it.
	 */
	checkoutProblem?: string;
	/** With `checkoutProblem`: whether the sandbox confirmed that it discarded the checkout. */
	checkoutDiscarded?: boolean;
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
	// Sized from the text that is sent, not from what was left out. Only a long run of backticks
	// is met with tildes, so the fence stays about as short as the patch's longest run.
	const fenceOf = (mark: "`" | "~") => {
		let length = 3;
		for (const [run] of patch.matchAll(mark === "`" ? /`+/g : /~+/g))
			length = Math.max(length, run.length + 1);
		return mark.repeat(length);
	};
	let fence = fenceOf("`");
	if (fence.length > 16) {
		const tildes = fenceOf("~");
		if (tildes.length < fence.length) fence = tildes;
	}
	const list = criteria.length
		? criteria.map((item, i) => `${i + 1}. ${item}`).join("\n")
		: "None. Review for correctness only.";
	return `Acceptance criteria\n${list}\n\nDiff\n${fence}diff\n${patch}${patch.endsWith("\n") ? "" : "\n"}${fence}`;
}
