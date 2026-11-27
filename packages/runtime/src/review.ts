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
import type { ProofRun } from "./proof-scripts";
import { lineOnDiff, parseDiff, readReviewDiff, restoreHead } from "./review-git";
import { SANDBOX_SERVER, type WriteResult } from "./sandbox-tools";
import { traced } from "./tools";
import type { RunRecorder } from "./trace";

export interface ReviewPort {
	/**
	 * Runs the command in the checkout in a session of its own and ends it and its process group
	 * within `seconds`, kill-after grace included, then says whether anything it started is alive.
	 */
	runProof(command: string, seconds: number): Promise<ProofRun>;
	/** Creates a file that does not exist yet; it never replaces a file or follows a symlink. */
	createFile(path: string, content: string): Promise<WriteResult>;
	changedSince(head: string): Promise<Comparison>;
	git: Git;
	/** Throws the checkout away, and every process that may still use it, so nothing reuses it. */
	discardCheckout(): Promise<void>;
}

export interface ReviewToolOptions {
	sandbox: ReviewPort;
	base: string;
	head: string;
	run: RunRecorder;
	record: (outcome: ReviewOutcome) => Promise<void>;
	/**
	 * The words that open the completed review: how many findings it holds, and that the pull
	 * request is a draft and why. They are made of the outcome, and come back with it as `summary`.
	 */
	summarize?: (outcome: ReviewOutcome) => string;
	now?: () => number;
}

interface Attempt {
	proof: ReviewProof;
	/** The command's call did not return: it may still be running in the checkout. */
	hung: boolean;
}

function unproven(reason: string): ReviewProof {
	return { proven: false, reason };
}

const NOT_PUT_BACK = "the checkout could not be put back at the reviewed head";
const HUNG = "a proof command did not return in time and may still be running in the checkout";

/** Resets, cleans and checks that nothing differs: why the checkout is not the head, or null. */
async function putBack(sandbox: ReviewPort, head: string): Promise<string | null> {
	if (await restoreHead((...args) => sandbox.git(...args), head)) return NOT_PUT_BACK;
	try {
		if ((await sandbox.changedSince(head)) !== null) return NOT_PUT_BACK;
	} catch {
		return NOT_PUT_BACK;
	}
	return null;
}

/** How long past the proof's deadline the tool still waits: the sandbox ends the proof by then. */
export const PROOF_WAIT_MARGIN_SECONDS = 3;

/**
 * Runs the command for at most `seconds`. The sandbox ends the command and its whole process
 * group by that deadline, its kill-after grace included, and then checks that nothing the proof
 * started is alive. This waits the deadline and a small margin; a call that has not returned by
 * then, or that reports a survivor, is a hang.
 */
async function runTest(sandbox: ReviewPort, command: string, seconds: number): Promise<Attempt> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			sandbox.runProof(command, seconds),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), (seconds + PROOF_WAIT_MARGIN_SECONDS) * 1000);
			}),
		]);
		if (!result)
			return {
				proof: unproven(`the command did not return within ${seconds} seconds`),
				hung: true,
			};
		const output = lastBytes(result.output, REVIEW_LIMITS.outputBytes);
		const { exitCode } = result;
		// A launch failure carries the sandbox's own exit code, which says nothing of the test, and
		// nothing was started that could still run.
		if (result.notStarted)
			return {
				proof: unproven(`the command did not start: ${output.trim() || "no reason given"}`),
				hung: false,
			};
		// A result that cannot confirm the process ended is a hang, whatever else it says: only an
		// integer exit code and a count of zero survivors show that nothing still uses the checkout.
		if (!Number.isInteger(exitCode) || result.left !== 0) {
			const survivors = typeof result.left === "number" && result.left > 0 ? result.left : null;
			return {
				proof: {
					proven: false,
					reason:
						survivors === null
							? "it could not be confirmed that every process the command started had ended"
							: `${survivors} process(es) the command started were still running after it ended`,
					output,
				},
				hung: true,
			};
		}
		if (result.timedOut)
			return {
				proof: { proven: false, reason: `the command timed out after ${seconds} seconds`, output },
				hung: false,
			};
		if (exitCode === 0)
			return {
				proof: { proven: false, reason: "the test passed at the reviewed head", exitCode, output },
				hung: false,
			};
		return { proof: { proven: true, exitCode, output }, hung: false };
	} catch {
		// A rejected call says nothing of the process: a failed read of its output can reject while
		// it is still running, so the checkout is not cleaned under it but discarded.
		return {
			proof: unproven(
				"the sandbox call failed, so it could not be confirmed that the command had ended",
			),
			hung: true,
		};
	} finally {
		clearTimeout(timer);
	}
}

export function reviewTools({
	sandbox,
	base,
	head,
	record,
	summarize,
	run,
	now = Date.now,
}: ReviewToolOptions): ToolSet {
	const git: Git = (...args) => sandbox.git(...args);
	// idle: nothing is recorded and no call runs; busy: a call runs; done: the outcome is recorded.
	// A call that fails before the outcome is recorded goes back to idle and keeps the outcome it
	// had finished, with the submission it belongs to, so a retry of that submission only records
	// it again and never runs the proofs, or their budgets, a second time. A different submission
	// is refused: it would be recorded under another review's outcome.
	let state: "idle" | "busy" | "done" = "idle";
	let finished: { submission: string; outcome: ReviewOutcome } | null = null;

	async function review(findings: ReviewFinding[]): Promise<ReviewOutcome> {
		const read = await readReviewDiff(git, base, head);
		if ("error" in read) throw new Error(`${read.error}; nothing was recorded; try again`);
		const diff = parseDiff(read.diff);
		const outcome: ReviewOutcome = { findings: [], proofsRun: 0, proofSeconds: 0 };
		/** Why no further proof may run: the checkout is not the head, or a command may still use it. */
		let unusable: string | null = null;
		let discarded: boolean | null = null;

		/** From now on no proof runs; the checkout and whatever may use it are thrown away, once. */
		async function retire(reason: string): Promise<void> {
			unusable ??= reason;
			if (discarded !== null) return;
			discarded = await sandbox.discardCheckout().then(
				() => true,
				() => false,
			);
		}

		async function attempt(
			relative: string,
			content: string,
			command: string,
			seconds: number,
		): Promise<Attempt> {
			const created = await sandbox
				.createFile(`${SANDBOX_REPOSITORY_PATH}/${relative}`, content)
				.catch(() => ({ error: "the file could not be created" }));
			if ("error" in created)
				return {
					proof: unproven(`the test file could not be created: ${created.error}`),
					hung: false,
				};
			// The new file must be the only difference, whatever the path held before.
			const status = await git([
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--ignore-submodules=none",
			]);
			if (status.exitCode !== 0 || status.timedOut || status.output !== `?? ${relative}\0`)
				return {
					proof: unproven(
						"the test file was not the only change in the checkout, so it was not run",
					),
					hung: false,
				};
			const started = now();
			const result = await runTest(sandbox, command, seconds);
			const elapsed = Math.max(0, (now() - started) / 1000);
			outcome.proofSeconds += result.hung ? Math.max(elapsed, seconds) : elapsed;
			return result;
		}

		async function prove(test: ReviewFinding["test"]): Promise<ReviewProof> {
			if (!test) return unproven("the finding proposes no test");
			if (outcome.proofsRun >= REVIEW_LIMITS.proofs)
				return unproven(`the review's limit of ${REVIEW_LIMITS.proofs} proofs was reached`);
			const timeLeft = REVIEW_LIMITS.totalProofSeconds - outcome.proofSeconds;
			if (timeLeft < 1) return unproven("the review's proof time was used up");
			if (unusable) return unproven(`no further proof ran: ${unusable}`);
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
			if (!namesFile(command, relative)) return unproven("the command does not run the test file");

			outcome.proofsRun++;
			// A proof starts on a checkout that is the head, and ends with one.
			const before = await putBack(sandbox, head);
			if (before) {
				await retire(before);
				return unproven(`${before}, so the test was not run`);
			}
			let result: Attempt;
			try {
				result = await attempt(
					relative,
					content,
					command,
					Math.floor(Math.min(REVIEW_LIMITS.proofSeconds, timeLeft)),
				);
			} catch {
				result = { proof: unproven("the proof could not be run"), hung: false };
			}
			// A command that never returned may be using the checkout, and cleaning would race it.
			if (result.hung) {
				await retire(HUNG);
				return result.proof;
			}
			const after = await putBack(sandbox, head);
			if (!after) return result.proof;
			await retire(after);
			return { ...result.proof, proven: false, reason: `${after} after this proof` };
		}

		for (const finding of findings) {
			outcome.findings.push({
				...finding,
				offDiff: !lineOnDiff(diff, finding),
				proof: await prove(finding.test),
			});
		}
		outcome.proofSeconds = Math.round(outcome.proofSeconds);
		if (unusable) {
			outcome.checkoutProblem = unusable;
			outcome.checkoutDiscarded = discarded === true;
		}
		return outcome;
	}

	const submit = tool({
		description:
			"Submit the review once. The tool runs each proposed test itself and decides whether the finding is proven. Supply a test file and a command that names it.",
		inputSchema: reviewInput,
		execute: async (input) => {
			// Parsed before the state changes, so a call the model must correct does not use up the
			// review; the state changes before the first `await`, so two calls cannot both run.
			const { findings } = reviewInput.parse(input);
			if (state !== "idle") throw new Error("The review was already submitted");
			state = "busy";
			try {
				const submission = JSON.stringify(findings);
				if (finished && finished.submission !== submission)
					throw new Error(
						"The first submission has run its proofs but is not recorded yet; submit the same findings again to record it",
					);
				finished ??= { submission, outcome: await review(findings) };
				await record(finished.outcome);
				state = "done";
				return summarize
					? { ...finished.outcome, summary: summarize(finished.outcome) }
					: finished.outcome;
			} catch (error) {
				state = "idle";
				throw error;
			}
		},
	});
	return {
		[REVIEW_TOOL]: traced(submit, SANDBOX_SERVER, REVIEW_TOOL, run, {
			showErrors: true,
			sandboxed: true,
		}),
	};
}
