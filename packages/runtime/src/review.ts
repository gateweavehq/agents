import {
	REVIEW_LIMITS,
	REVIEW_TOOL,
	type ReviewFinding,
	type ReviewOutcome,
	type ReviewProof,
	reviewInput,
	SANDBOX_REPOSITORY_PATH,
} from "@gateweave/agents-model";
import { type ToolSet, tool } from "ai";
import { type Comparison, lastBytes } from "./checks";
import type { Git } from "./git-work";
import { namesFile, oracleKind } from "./oracles";
import { lineOnDiff, parseDiff, readReviewDiff, restoreHead } from "./review-git";
import { SANDBOX_SERVER, type SandboxPort } from "./sandbox-tools";
import { traced } from "./tools";
import type { RunRecorder } from "./trace";

export interface ReviewPort {
	run: SandboxPort["run"];
	writeFile: SandboxPort["writeFile"];
	changedSince(head: string): Promise<Comparison>;
	git: Git;
}

export interface ReviewToolOptions {
	sandbox: ReviewPort;
	base: string;
	head: string;
	run: RunRecorder;
	record: (outcome: ReviewOutcome) => Promise<void>;
	now?: () => number;
}

function unproven(reason: string): ReviewProof {
	return { proven: false, reason };
}

async function runTest(
	sandbox: ReviewPort,
	command: string,
	seconds: number,
): Promise<ReviewProof> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			sandbox.run(command, SANDBOX_REPOSITORY_PATH, seconds),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), (seconds + 10) * 1000);
			}),
		]);
		if (!result) return unproven(`the command was stopped after ${seconds} seconds`);
		const output = lastBytes(result.output, REVIEW_LIMITS.outputBytes);
		const { exitCode } = result;
		if (result.timedOut)
			return { proven: false, reason: `the command timed out after ${seconds} seconds`, output };
		if (exitCode === 0)
			return { proven: false, reason: "the test passed at the reviewed head", exitCode, output };
		return { proven: true, exitCode, output };
	} catch {
		return unproven("the sandbox could not run the command");
	} finally {
		clearTimeout(timer);
	}
}

export function reviewTools({
	sandbox,
	base,
	head,
	record,
	run,
	now = Date.now,
}: ReviewToolOptions): ToolSet {
	const git: Git = (...args) => sandbox.git(...args);
	let submitted = false;
	const submit = tool({
		description:
			"Submit the review once. The tool runs each proposed test itself and decides whether the finding is proven. Supply a test file and a command that names it.",
		inputSchema: reviewInput,
		execute: async (input) => {
			// Parsed before the flag is set, so a call the model must correct does not use up the
			// review; the flag is still set before the first `await`, so two calls cannot both run.
			const { findings } = reviewInput.parse(input);
			if (submitted) throw new Error("The review was already submitted");
			submitted = true;
			const read = await readReviewDiff(git, base, head);
			if ("error" in read) {
				submitted = false;
				throw new Error(`${read.error}; nothing was recorded; try again`);
			}
			const diff = parseDiff(read.diff);
			const outcome: ReviewOutcome = { findings: [], proofsRun: 0, proofSeconds: 0 };
			let restoreFailed = false;
			async function prove(test: ReviewFinding["test"]): Promise<ReviewProof> {
				if (!test) return unproven("the finding proposes no test");
				if (outcome.proofsRun >= REVIEW_LIMITS.proofs)
					return unproven(`the review's limit of ${REVIEW_LIMITS.proofs} proofs was reached`);
				const timeLeft = REVIEW_LIMITS.totalProofSeconds - outcome.proofSeconds;
				if (timeLeft < 1) return unproven("the review's proof time was used up");
				if (restoreFailed)
					return unproven(
						"the checkout could not be put back at the reviewed head after an earlier proof",
					);
				const { path, content, command } = test;
				const parts = path.split("/");
				if (
					/^\/|^[a-z]:|\\|[\p{Cc}\p{Zl}\p{Zp}]/iu.test(path) ||
					parts.includes("..") ||
					parts.includes(".git")
				)
					return unproven("the test's path is not a path inside the repository");
				const relative = parts.filter((part) => part !== "" && part !== ".").join("/");
				if (oracleKind(relative) !== "test") return unproven("the test's path is not a test file");
				if (!namesFile(command, relative))
					return unproven("the command does not run the test file");

				outcome.proofsRun++;
				const reason = await restoreHead(git, head);
				if (reason) {
					restoreFailed = true;
					return unproven(reason);
				}
				try {
					const written = await sandbox
						.writeFile(`${SANDBOX_REPOSITORY_PATH}/${path}`, content)
						.catch(() => ({ error: "write failed" }));
					if ("error" in written) return unproven("the test file could not be written");
					const started = now();
					const proof = await runTest(
						sandbox,
						command,
						Math.floor(Math.min(REVIEW_LIMITS.proofSeconds, timeLeft)),
					);
					outcome.proofSeconds += Math.max(0, (now() - started) / 1000);
					return proof;
				} finally {
					const reason = await restoreHead(git, head);
					try {
						const changes = await sandbox.changedSince(head);
						restoreFailed = reason !== null || changes !== null;
					} catch {
						restoreFailed = true;
					}
				}
			}
			for (const finding of findings) {
				outcome.findings.push({
					...finding,
					offDiff: !lineOnDiff(diff, finding),
					proof: await prove(finding.test),
				});
			}
			outcome.proofSeconds = Math.round(outcome.proofSeconds);
			await record(outcome);
			return outcome;
		},
	});
	return {
		[REVIEW_TOOL]: traced(submit, SANDBOX_SERVER, REVIEW_TOOL, run, {
			showErrors: true,
			sandboxed: true,
		}),
	};
}
