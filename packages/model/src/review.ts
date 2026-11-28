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
/** A passed replay-gate run, copied here so the product can say whether review may be offered. */
export interface ReviewGatePass {
	/** The day the run passed, as `YYYY-MM-DD`. */
	date: string;
	engine: string;
	model: string;
	hits: number;
	realShare: number;
}

export const REVIEW_GATE = {
	bar: { rows: 35, hits: 12, realShare: 0.5 },
	/** Null until a real replay passes and its precision is checked; then its figures are copied here. */
	passed: null as ReviewGatePass | null,
} as const;

/** Whether review may be offered: only a passed replay gate opens the ready-made setup. */
export function reviewGatePassed(gate: Pick<typeof REVIEW_GATE, "passed"> = REVIEW_GATE): boolean {
	return gate.passed !== null;
}

/** The gate's figures as the setup dialog shows them. */
export function reviewGateLine(pass: ReviewGatePass): string {
	const share = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 }).format(
		pass.realShare,
	);
	return `The replay gate passed on ${pass.date}, with ${pass.engine} on ${pass.model}: ${pass.hits} of ${REVIEW_GATE.bar.rows} seeded defects found, and ${share} of the reviews real.`;
}

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
			// Proof and test describe one run: a proven duplicate brings the test it ran along.
			...(first.proof.proven || !finding.proof.proven
				? {}
				: { proof: finding.proof, test: finding.test }),
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

/** GitHub refuses a review body longer than this. */
export const REVIEW_SUMMARY_LIMIT = 65_536;

export interface RenderedReviewComment {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	body: string;
}

function inline(text: string, limit = 500): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join("")}…`;
}

function charsOf(text: string, limit: number): string {
	return Array.from(text).slice(0, limit).join("");
}

function proofText({ proof, test }: ReviewedFinding): string {
	const command = test ? `\`${test.command}\`` : "no test command";
	return proof.proven
		? `Proven: ${command} exited ${proof.exitCode}.`
		: `Unproven: ${inline(proof.reason).replace(/[.]+$/, "")}.`;
}

function testText({ test }: ReviewedFinding): string {
	return test
		? `Proposed test: \`${test.path}\` with \`${test.command}\`.`
		: "Proposed test: none.";
}

function findingText(finding: ReviewedFinding): string {
	return [
		proofText(finding),
		`Failing case: ${inline(finding.failingCase).replace(/[.]+$/, "")}.`,
		testText(finding),
	].join(" ");
}

function commentBody(finding: ReviewedFinding): string {
	return [
		`**${finding.severity}: ${finding.title}**`,
		proofText(finding),
		`Failing case: ${finding.failingCase}`,
		testText(finding),
	].join("\n\n");
}

function disclosure(agentName: string | null | undefined): string {
	const name = Array.from((agentName ?? "").replace(/[`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim())
		.slice(0, 100)
		.join("")
		.trimEnd();
	const byline = name ? `\`${name}\`, an AI agent` : "an AI agent";
	return `Written by ${byline} in Gateweave Agents.\n<!-- AI-Disclosure: mode=machine-generated -->`;
}

/**
 * The GitHub review of one review run. Only the findings ranked as shown and on the diff become
 * line comments; off-diff and collapsed findings stay in the summary. The wording is fixed so a
 * machine review never reads as a person's approval, and it ends with the same AI disclosure as
 * an agent's pull request.
 */
export function renderReview({
	findings,
	agentName,
	runsPage = null,
}: {
	findings: readonly ReviewedFinding[];
	agentName?: string | null;
	/** The review run's page, linked from the summary when the app knows it. */
	runsPage?: string | null;
}): { summary: string; comments: RenderedReviewComment[] } {
	const ranked = rankFindings(findings);
	const lines = [
		"A second reader's findings, not an approval. A person reviews and merges.",
		runsPage ? `Review run: ${runsPage}` : null,
	];
	if (ranked.shown.length + ranked.collapsed.length === 0) {
		lines.push("No findings. This is not an approval.");
	} else {
		const shown = ranked.shown.map((finding, index) => {
			const place = `\`${finding.path}:${finding.line}\``;
			return `${index + 1}. **${finding.severity}: ${finding.title}** (${place}) — ${findingText(finding)}`;
		});
		const onDiff = ranked.shown.filter((finding) => !finding.offDiff).length;
		const offDiff = ranked.shown.length - onDiff;
		lines.push(
			`${ranked.shown.length} shown ${ranked.shown.length === 1 ? "finding" : "findings"}: ${onDiff} on the diff, ${offDiff} off it.`,
			...shown,
		);
		if (ranked.collapsed.length > 0) {
			const collapsed = ranked.collapsed.map(
				(finding) =>
					`- **${finding.severity}: ${finding.title}** (\`${finding.path}:${finding.line}\`) — ${findingText(finding)}`,
			);
			lines.push(
				`<details>\n<summary>Collapsed findings (${ranked.collapsed.length})</summary>\n\n${collapsed.join("\n")}\n</details>`,
			);
		}
	}
	const end = disclosure(agentName);
	const body = lines.filter((line) => line !== null).join("\n\n");
	let summary = `${body}\n\n${end}`;
	if (summary.length > REVIEW_SUMMARY_LIMIT) {
		const notice = "\n\n[The summary was shortened to fit GitHub's limit.]";
		const room = REVIEW_SUMMARY_LIMIT - notice.length - end.length - 2;
		summary = `${charsOf(body, Math.max(0, room))}${notice}\n\n${end}`;
	}
	return {
		summary,
		comments: ranked.shown
			.filter((finding) => !finding.offDiff)
			.map((finding) => ({
				path: finding.path,
				line: finding.line,
				side: finding.side,
				body: commentBody(finding),
			})),
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
