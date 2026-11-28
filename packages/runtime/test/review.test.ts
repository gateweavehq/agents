import { SANDBOX_REPOSITORY_PATH } from "@gateweave/agents-model";
import { describe, expect, it, vi } from "vitest";
import type { ProofRun } from "../src/proof-scripts";
import { PROOF_WAIT_MARGIN_SECONDS } from "../src/review";
import { answer, finding, HEAD, MERGE_BASE, setup } from "./review-fixture";

const failed = answer("first".repeat(200) + "tail".repeat(1000), 1);
const reset = `git reset --hard --quiet ${HEAD}`;
const compare = `compare ${HEAD.slice(0, 7)}`;
const runCommand = `run ${finding.test.command}`;
const created = `create ${SANDBOX_REPOSITORY_PATH}/${finding.test.path}`;
const status = "git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none";
const notPutBack = "the checkout could not be put back at the reviewed head";
const later = `no further proof ran: ${notPutBack}`;
const HUNG = "a proof command did not return in time and may still be running in the checkout";

describe("submitting a review", () => {
	it.each([0, 1])("strips a submitted proof claim and uses exit code %i", async (exitCode) => {
		const { sandbox, call } = setup();
		sandbox.answers.push({ ...failed, exitCode });
		const { findings } = await call([{ ...finding, proven: true }]);
		expect(findings[0]).not.toHaveProperty("proven");
		expect(findings[0]?.proof).toMatchObject({
			proven: exitCode !== 0,
			exitCode,
			output: "tail".repeat(1000),
		});
		expect(sandbox.created).toEqual([
			{ path: `${SANDBOX_REPOSITORY_PATH}/${finding.test.path}`, content: finding.test.content },
		]);
	});
	it("rejects invalid direct calls before reading the checkout", async () => {
		const { sandbox, record, call } = setup();
		await expect(call([{ ...finding, line: 0 }])).rejects.toThrow(/line/);
		expect(sandbox.gitCalls).toEqual([]);
		expect(record).not.toHaveBeenCalled();
	});
	it("keeps a finding that proposes no test", async () => {
		const { call } = setup();
		expect(await call([{ ...finding, test: null }])).toMatchObject({
			proofsRun: 0,
			findings: [{ proof: { proven: false, reason: "the finding proposes no test" } }],
		});
	});
	it("treats a rejected proof call as a hang: discards the checkout and never cleans it under the process", async () => {
		const { sandbox, call } = setup();
		// A failed read of the process's output rejects the call while the process still runs.
		let running = false;
		vi.spyOn(sandbox, "runProof").mockImplementation(async () => {
			running = true;
			throw new Error("stdout read failed");
		});
		const cleaned: boolean[] = [];
		const normal = sandbox.gitAnswer;
		sandbox.gitAnswer = (args) => {
			if (args[0] === "reset" || args[0] === "clean") cleaned.push(running);
			return normal?.(args);
		};
		const outcome = await call([finding, finding]);
		expect(outcome.findings.map((f) => f.proof)).toEqual([
			{
				proven: false,
				reason: "the sandbox call failed, so it could not be confirmed that the command had ended",
			},
			{ proven: false, reason: `no further proof ran: ${HUNG}` },
		]);
		expect(outcome).toMatchObject({ checkoutProblem: HUNG, checkoutDiscarded: true });
		// The only reset and clean ran before the command started; none after it.
		expect(cleaned).toEqual([false, false]);
		expect(sandbox.log.slice(-2)).toEqual([status, "discard"]);
		expect(sandbox.discards).toBe(1);
	});
	it.each([
		["a non-integer exit code", Number.NaN, 0],
		["no count of surviving processes", 1, undefined],
	])("treats %s as an unconfirmed end: a hang", async (_name, exitCode, left) => {
		const { sandbox, call } = setup();
		vi.spyOn(sandbox, "runProof").mockResolvedValue({
			...answer("", exitCode),
			left,
		} as unknown as ProofRun);
		const outcome = await call([finding, finding]);
		expect(outcome.findings[0]?.proof).toMatchObject({
			proven: false,
			reason: "it could not be confirmed that every process the command started had ended",
		});
		expect(outcome).toMatchObject({ checkoutProblem: HUNG, checkoutDiscarded: true });
		expect(sandbox.log.slice(-2)).toEqual([status, "discard"]);
	});
	it("keeps the output tail of a timed-out command without proving it", async () => {
		const { sandbox, call } = setup();
		sandbox.answers.push({ ...failed, seconds: 300, timedOut: true });
		expect(await call()).toMatchObject({
			proofSeconds: 300,
			findings: [
				{
					proof: {
						proven: false,
						reason: "the command timed out after 300 seconds",
						output: "tail".repeat(1000),
					},
				},
			],
		});
	});
	it("waits the proof's deadline and a small margin, then discards the checkout and runs no further proof", async () => {
		vi.useFakeTimers();
		try {
			const { sandbox, call, record } = setup();
			const hung = vi.spyOn(sandbox, "runProof").mockImplementation(() => new Promise(() => {}));
			const pending = call(Array(3).fill(finding));
			// The sandbox ends the proof by its deadline, so only the margin is waited beyond it.
			await vi.advanceTimersByTimeAsync(300_000 + PROOF_WAIT_MARGIN_SECONDS * 1000 - 1);
			expect(record).not.toHaveBeenCalled();
			expect(sandbox.discards).toBe(0);
			sandbox.clock += (300 + PROOF_WAIT_MARGIN_SECONDS) * 1000;
			await vi.advanceTimersByTimeAsync(1);
			const outcome = await pending;
			expect(outcome.proofSeconds).toBe(300 + PROOF_WAIT_MARGIN_SECONDS);
			expect(outcome.checkoutProblem).toBe(HUNG);
			expect(outcome.checkoutDiscarded).toBe(true);
			expect(sandbox.discards).toBe(1);
			expect(outcome.findings.map((f) => f.proof)).toEqual([
				{ proven: false, reason: "the command did not return within 300 seconds" },
				{ proven: false, reason: `no further proof ran: ${HUNG}` },
				{ proven: false, reason: `no further proof ran: ${HUNG}` },
			]);
			expect(hung).toHaveBeenCalledTimes(1);
			// The command may still be running: nothing cleans the checkout under it, it is discarded.
			expect(sandbox.log.slice(-2)).toEqual([status, "discard"]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("explains a passing test", async () => {
		const { sandbox, call } = setup();
		sandbox.answers.push(answer("passed"));
		expect((await call()).findings[0]?.proof).toEqual({
			proven: false,
			reason: "the test passed at the reviewed head",
			exitCode: 0,
			output: "passed",
		});
	});
	it.each(["src/app.ts", "package.json", ".github/workflows/x.yml", "scripts/check.ts"])(
		"refuses a proposed file outside the tests: %s",
		async (path) => {
			const { call, sandbox } = setup();
			sandbox.answers.push(failed);
			const { findings } = await call([
				{ ...finding, test: { ...finding.test, path, command: `pnpm test ${path}` } },
			]);
			expect(findings[0]?.proof).toEqual({
				proven: false,
				reason: "the test's path is not a test file",
			});
			expect(sandbox.created).toEqual([]);
		},
	);
	it.each([
		"exit 1",
		"false",
		"pnpm test",
		"pnpm vitest run test/b.test.ts",
		"echo test/a.test.ts; exit 1",
		"echo test/a.test.ts && exit 1",
		"echo test/a.test.ts || exit 1",
		"true && test/a.test.ts",
		"vitest run # test/a.test.ts",
		"echo > vitest run test/a.test.ts; exit 1",
		"vitest run > test/a.test.ts",
	])("refuses a command that does not run the file: %s", async (command) => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed);
		expect(
			(await call([{ ...finding, test: { ...finding.test, command } }])).findings[0]?.proof,
		).toEqual({ proven: false, reason: "the command does not run the test file" });
		expect(sandbox.commands).toEqual([]);
	});
	it.each(["./test/a.test.ts", "a.test.ts"])("accepts the test named as %s", async (spelling) => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed);
		expect(
			(
				await call([
					{ ...finding, test: { ...finding.test, command: `pnpm vitest run ${spelling}` } },
				])
			).findings[0]?.proof.proven,
		).toBe(true);
	});
	it.each([
		"vitest run test/a.test.ts",
		"node --test test/a.test.ts",
		"vitest run test/a.test.ts >proof.out",
		"vitest run test/a.test.ts 2>proof.err",
		"vitest run test/a.test.ts 2>&1",
	])("accepts the file as a runner argument: %s", async (command) => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed);
		expect(
			(await call([{ ...finding, test: { ...finding.test, command } }])).findings[0]?.proof.proven,
		).toBe(true);
	});
	it.each([
		"../test/a.ts",
		"/test/a.ts",
		"C:/test/a.ts",
		"test/a\\b.ts",
		".git/test/a.ts",
		"./.git/test/a.ts",
		"test/a\0b.ts",
		"test/a\tb.ts",
	])("refuses an unusable path %j before writing", async (path) => {
		const { call, sandbox } = setup();
		expect(
			(await call([{ ...finding, test: { ...finding.test, path } }])).findings[0]?.proof,
		).toEqual({ proven: false, reason: "the test's path is not a path inside the repository" });
		expect(sandbox.created).toEqual([]);
		expect(sandbox.commands).toEqual([]);
	});
	it("counts a create error and cleans up without running the command", async () => {
		const { call, sandbox } = setup();
		sandbox.createError = "read only";
		expect(await call()).toMatchObject({
			proofsRun: 1,
			findings: [
				{ proof: { proven: false, reason: "the test file could not be created: read only" } },
			],
		});
		expect(sandbox.commands).toEqual([]);
		expect(sandbox.log.slice(-3)).toEqual([reset, "git clean -fdq", compare]);
	});
	it("never writes over a file that exists, and runs nothing", async () => {
		const { call, sandbox } = setup();
		const path = `${SANDBOX_REPOSITORY_PATH}/${finding.test.path}`;
		sandbox.files.set(path, "tracked application code");
		const { findings } = await call();
		expect(findings[0]?.proof).toEqual({
			proven: false,
			reason: `the test file could not be created: ${path} already exists`,
		});
		expect(sandbox.files.get(path)).toBe("tracked application code");
		expect(sandbox.commands).toEqual([]);
	});
	it("does not run a test when the new file is not the only change in the checkout", async () => {
		const { call, sandbox } = setup();
		const normal = sandbox.gitAnswer;
		sandbox.gitAnswer = (args) =>
			args[0] === "status" ? answer(` M app.ts\0?? ${finding.test.path}\0`) : normal?.(args);
		const { findings } = await call();
		expect(findings[0]?.proof).toEqual({
			proven: false,
			reason: "the test file was not the only change in the checkout, so it was not run",
		});
		expect(sandbox.commands).toEqual([]);
		expect(sandbox.log.slice(-4)).toEqual([
			reset,
			"git clean -fdq",
			`git clean -fdqx -- :(literal)${finding.test.path}`,
			compare,
		]);
	});
	it("does not run a test whose file git neither lists nor marks ignored", async () => {
		const { call, sandbox } = setup();
		const normal = sandbox.gitAnswer;
		sandbox.gitAnswer = (args) => (args[0] === "status" ? answer("") : normal?.(args));
		expect((await call()).findings[0]?.proof.proven).toBe(false);
		expect(sandbox.commands).toEqual([]);
	});
	it("does not count a launch failure as a proof", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push({
			...answer("/workspace/repo could not be reached.", 1),
			notStarted: true,
		});
		expect((await call()).findings[0]?.proof).toEqual({
			proven: false,
			reason: "the command did not start: /workspace/repo could not be reached.",
		});
	});
	it.each([Number.NaN, 1.5])("does not count exit code %s as a proof", async (exitCode) => {
		const { call, sandbox } = setup();
		sandbox.answers.push(answer("", exitCode));
		expect((await call()).findings[0]?.proof.proven).toBe(false);
	});
	it("keeps the valid findings when one omits its test or its criterion", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed);
		const { test: _test, criterion: _criterion, ...incomplete } = finding;
		const { findings } = await call([incomplete, finding]);
		expect(findings.map((f) => [f.test === null, f.criterion, f.proof.proven])).toEqual([
			[true, null, false],
			[false, null, true],
		]);
		expect(findings[0]?.proof).toEqual({
			proven: false,
			reason: "the finding proposes no test",
		});
	});
	it("runs only eight proofs", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(...Array(10).fill(failed));
		const result = await call(Array(10).fill(finding));
		expect(result.proofsRun).toBe(8);
		expect(sandbox.commands).toHaveLength(8);
		expect(result.findings.filter((f) => f.proof.proven)).toHaveLength(8);
		expect(result.findings.slice(8).map((f) => f.proof)).toEqual(
			Array(2).fill({ proven: false, reason: "the review's limit of 8 proofs was reached" }),
		);
	});
	it("stops after fifteen minutes of proof commands", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(...Array(4).fill({ ...failed, seconds: 300 }));
		const result = await call(Array(4).fill(finding));
		expect(result.proofSeconds).toBe(900);
		expect(sandbox.commands).toHaveLength(3);
		expect(result.findings[3]?.proof).toEqual({
			proven: false,
			reason: "the review's proof time was used up",
		});
	});
	it("gives each proof only the whole seconds it has left", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(...[200, 300, 299.6, 100].map((seconds) => ({ ...failed, seconds })));
		expect((await call(Array(4).fill(finding))).proofSeconds).toBe(900);
		expect(sandbox.commands.map((c) => c.timeoutSeconds)).toEqual([300, 300, 300, 100]);
	});
	it("restores before and after each proof and compares after each cleanup", async () => {
		const { call, sandbox } = setup();
		await call([finding, finding]);
		const one = [
			reset,
			"git clean -fdq",
			compare,
			created,
			status,
			runCommand,
			reset,
			"git clean -fdq",
			`git clean -fdqx -- :(literal)${finding.test.path}`,
			compare,
		];
		expect(sandbox.log.slice(2)).toEqual([...one, ...one]);
	});
	it("runs and removes a proof test in a git-ignored folder", async () => {
		const { call, sandbox } = setup();
		sandbox.ignored.add("dist");
		sandbox.answers.push(failed);
		const test = {
			path: "dist/test/a.test.ts",
			content: finding.test.content,
			command: "pnpm vitest run dist/test/a.test.ts",
		};
		const outcome = await call([{ ...finding, test }]);
		expect(outcome.findings[0]?.proof.proven).toBe(true);
		expect(sandbox.commands.map((command) => command.command)).toEqual([test.command]);
		expect(sandbox.files.has(`${SANDBOX_REPOSITORY_PATH}/${test.path}`)).toBe(false);
		expect(sandbox.untracked.has(test.path)).toBe(false);
		expect(sandbox.gitCalls).toContainEqual(["check-ignore", "-q", "--", test.path]);
		expect(sandbox.gitCalls).toContainEqual(["clean", "-fdqx", "--", `:(literal)${test.path}`]);
	});
	it("does not mistake a dependency file the runner excludes for a failing proof", async () => {
		const { call, sandbox } = setup();
		sandbox.ignored.add("node_modules");
		sandbox.answers.push(failed);
		const test = {
			path: "node_modules/pkg/a.test.ts",
			content: finding.test.content,
			command: "pnpm vitest run node_modules/pkg/a.test.ts",
		};
		const outcome = await call([{ ...finding, test }]);
		expect(outcome.findings[0]?.proof).toEqual({
			proven: false,
			reason: "the test's path is inside the repository's dependencies",
		});
		expect(sandbox.created).toEqual([]);
		expect(sandbox.commands).toEqual([]);
	});
	it.each(["changed", "compare throws", "reset fails", "clean fails"])(
		"shows a failed cleanup on this submission and refuses the next proof: %s",
		async (mode) => {
			const { call, sandbox } = setup();
			sandbox.answers.push(failed);
			if (mode === "changed") sandbox.changes.push(null, { changed: "dirty" });
			else if (mode === "compare throws") sandbox.changes.push(null, new Error("unavailable"));
			else {
				const normal = sandbox.gitAnswer;
				sandbox.gitAnswer = (args) =>
					sandbox.commands.length && args[0] === mode.split(" ")[0]
						? answer("", 1)
						: normal?.(args);
			}
			const outcome = await call([finding, finding]);
			expect(outcome.checkoutProblem).toBe(notPutBack);
			expect(outcome.findings[0]?.proof).toEqual({
				proven: false,
				reason: `${notPutBack} after this proof`,
				exitCode: 1,
				output: failed.output.slice(-4000),
			});
			expect(outcome.findings[1]?.proof).toEqual({ proven: false, reason: later });
			expect(sandbox.commands).toHaveLength(1);
			// The checkout is thrown away, once, so nothing reuses it.
			expect(sandbox.discards).toBe(1);
			expect(outcome.checkoutDiscarded).toBe(true);
		},
	);
	it("discards the checkout when the final proof leaves it dirty", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed);
		// A dirty submodule that survives the reset: the comparison after the proof still differs.
		sandbox.changes.push(null, { changed: "m vendor/lib" });
		const outcome = await call([finding]);
		expect(outcome.findings[0]?.proof).toMatchObject({
			proven: false,
			reason: `${notPutBack} after this proof`,
		});
		expect(outcome).toMatchObject({ checkoutProblem: notPutBack, checkoutDiscarded: true });
		expect(sandbox.discards).toBe(1);
		expect(sandbox.log.at(-1)).toBe("discard");
	});
	it("discards a checkout that could not be put back before a proof", async () => {
		const { call, sandbox } = setup();
		sandbox.changes.push({ changed: "M app.ts" });
		const outcome = await call([finding, finding]);
		expect(sandbox.discards).toBe(1);
		expect(outcome.checkoutDiscarded).toBe(true);
	});
	it("says so when the checkout could not be discarded, and the sandbox is not reused until it is", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed);
		sandbox.changes.push(null, { changed: "dirty" });
		sandbox.discardError = new Error("container would not stop");
		const outcome = await call([finding]);
		expect(outcome).toMatchObject({ checkoutProblem: notPutBack, checkoutDiscarded: false });
		expect(outcome.findings[0]?.proof.proven).toBe(false);
		// The container is still there, dirty: nothing is handed out while its destroy keeps failing.
		const refused = /could not be destroyed yet, so it is not reused/;
		await expect(sandbox.git(["status"])).rejects.toThrow(refused);
		await expect(sandbox.runProof(finding.test.command, 5)).rejects.toThrow(refused);
		await expect(sandbox.createFile("x/new.test.ts", "")).rejects.toThrow(refused);
		// Once a destroy succeeds the sandbox is usable again, on the fresh container.
		sandbox.discardError = undefined;
		await expect(sandbox.git(["status"])).resolves.toMatchObject({ exitCode: 0 });
	});
	it("does not discard a checkout that every proof left clean", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed, failed);
		const outcome = await call([finding, finding]);
		expect(sandbox.discards).toBe(0);
		expect(outcome).not.toHaveProperty("checkoutDiscarded");
	});
	it.each([
		[1, "1 process(es) the command started were still running after it ended"],
		[3, "3 process(es) the command started were still running after it ended"],
		[null, "it could not be confirmed that every process the command started had ended"],
	])(
		"counts %s surviving processes as a hang: unproven, no further proof, checkout discarded",
		async (left, reason) => {
			const { call, sandbox } = setup();
			sandbox.answers.push(failed);
			sandbox.left.push(left);
			const outcome = await call([finding, finding]);
			expect(outcome.findings[0]?.proof).toEqual({
				proven: false,
				reason,
				output: failed.output.slice(-4000),
			});
			expect(outcome.findings[1]?.proof).toEqual({
				proven: false,
				reason: `no further proof ran: ${HUNG}`,
			});
			expect(outcome).toMatchObject({ checkoutProblem: HUNG, checkoutDiscarded: true });
			expect(sandbox.commands).toHaveLength(1);
			expect(sandbox.discards).toBe(1);
			// Nothing cleans the checkout under a process that may still use it.
			expect(sandbox.log.slice(-2)).toEqual([runCommand, "discard"]);
		},
	);
	it("does not start a proof on a checkout that differs from the head", async () => {
		const { call, sandbox } = setup();
		sandbox.changes.push({ changed: "M app.ts" });
		const outcome = await call([finding, finding]);
		expect(outcome.checkoutProblem).toBe(notPutBack);
		expect(outcome.findings.map((f) => f.proof)).toEqual([
			{ proven: false, reason: `${notPutBack}, so the test was not run` },
			{ proven: false, reason: later },
		]);
		expect(sandbox.commands).toEqual([]);
		expect(sandbox.created).toEqual([]);
	});
	it("refuses subsequent proofs if restoring before a command failed", async () => {
		const { call, sandbox } = setup();
		const normal = sandbox.gitAnswer;
		sandbox.gitAnswer = (args) =>
			args[0] === "reset" ? new Error("lost checkout") : normal?.(args);
		const result = await call([finding, finding]);
		expect(result.proofsRun).toBe(1);
		expect(result.checkoutProblem).toBe(notPutBack);
		expect(result.findings.map((f) => f.proof)).toEqual([
			{ proven: false, reason: `${notPutBack}, so the test was not run` },
			{ proven: false, reason: later },
		]);
		expect(sandbox.commands).toEqual([]);
	});
	it("records no checkout problem when every proof left the checkout clean", async () => {
		const { call } = setup();
		expect(await call()).not.toHaveProperty("checkoutProblem");
	});
	it("reads the diff from the common base and reviewed commit", async () => {
		const { call, sandbox } = setup();
		await call([{ ...finding, diff: "fake", mergeBase: "fake" }]);
		expect(sandbox.gitCalls.slice(0, 2)).toEqual([
			["merge-base", "origin/main", HEAD],
			[
				"-c",
				"core.quotePath=false",
				"diff",
				"--no-color",
				"--no-ext-diff",
				"--find-renames",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--unified=3",
				MERGE_BASE,
				HEAD,
				"--",
			],
		]);
	});
	it("allows a retry when the diff could not be read", async () => {
		const { call, sandbox, record } = setup();
		const normal = sandbox.gitAnswer;
		sandbox.gitAnswer = () => new Error("git unavailable");
		await expect(call([])).rejects.toThrow(/nothing was recorded; try again/);
		expect(record).not.toHaveBeenCalled();
		sandbox.gitAnswer = normal;
		expect(await call([])).toEqual({ findings: [], proofsRun: 0, proofSeconds: 0 });
	});
	it("marks off-diff findings in place and runs their proofs", async () => {
		const { call, sandbox } = setup();
		sandbox.answers.push(failed);
		const locations = [
			{ path: "app.ts", line: 2 },
			{ path: "app.ts", line: 3, side: "LEFT" },
			{ path: "old", line: 5, side: "LEFT" },
			{ path: "new", line: 5 },
			{ path: "absent", line: 1 },
		];
		const { findings } = await call(locations.map((loc) => ({ ...finding, ...loc })));
		expect(findings.map((f) => f.offDiff)).toEqual([true, false, false, false, true]);
		expect(findings[0]?.proof.proven).toBe(true);
	});
	it("checks the findings against the diff it was given and makes no other", async () => {
		// The supplied patch holds app.ts line 40; the sandbox's own diff, which would be the one
		// recomputed, does not.
		const given = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -40 +40 @@
-before
+after
`;
		const { call, sandbox } = setup(undefined, given);
		const { findings } = await call([
			{ ...finding, test: null, line: 40 },
			{ ...finding, test: null, line: 1 },
		]);
		// Line 40 is on the supplied diff; line 1 is only on the recomputed one.
		expect(findings.map((f) => f.offDiff)).toEqual([false, true]);
		expect(sandbox.gitCalls).toEqual([]);
	});
	it("records the returned outcome and traces submit_review", async () => {
		const { call, run, record } = setup();
		const outcome = await call();
		expect(record).toHaveBeenCalledExactlyOnceWith(outcome);
		expect(run.toolStarted).toHaveBeenCalledWith(
			expect.any(String),
			"submit_review",
			expect.any(Number),
		);
		expect(run.toolEnded).toHaveBeenCalledOnce();
	});
	it("lets a call that failed validation be corrected", async () => {
		const { call, record } = setup();
		await expect(call([{ ...finding, line: 0 }])).rejects.toThrow(/line/);
		expect((await call()).findings).toHaveLength(1);
		expect(record).toHaveBeenCalledOnce();
	});
	it("lets a call whose record failed be recorded again without running the proofs again", async () => {
		const { call, record, sandbox } = setup();
		record.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(call()).rejects.toThrow("storage unavailable");
		const commands = sandbox.commands.length;
		const retried = await call();
		expect(retried.findings).toHaveLength(1);
		expect(retried.proofsRun).toBe(1);
		expect(sandbox.commands).toHaveLength(commands);
		expect(record).toHaveBeenCalledTimes(2);
		expect(record.mock.calls[1]?.[0]).toBe(record.mock.calls[0]?.[0]);
		await expect(call([])).rejects.toThrow("The review was already submitted");
	});
	it("refuses a different submission while an earlier one waits to be recorded", async () => {
		const { call, record, sandbox } = setup();
		record.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(call()).rejects.toThrow("storage unavailable");
		const commands = sandbox.commands.length;
		await expect(call([{ ...finding, title: "Another finding" }])).rejects.toThrow(
			/submit the same findings again/,
		);
		// Nothing was recorded for the other submission, and its proofs did not run.
		expect(record).toHaveBeenCalledTimes(1);
		expect(sandbox.commands).toHaveLength(commands);
		// The same findings still record the first outcome, once.
		const retried = await call();
		expect(retried.findings[0]?.title).toBe(finding.title);
		expect(record).toHaveBeenCalledTimes(2);
		await expect(call([])).rejects.toThrow("The review was already submitted");
	});
	it("refuses a second submission", async () => {
		const { call } = setup();
		await call([]);
		await expect(call([])).rejects.toThrow("The review was already submitted");
	});
	it("admits only one concurrent submission", async () => {
		const { call, record, sandbox } = setup();
		const first = call();
		await expect(call()).rejects.toThrow("The review was already submitted");
		await first;
		expect(record).toHaveBeenCalledOnce();
		expect(sandbox.commands).toHaveLength(1);
	});
});
