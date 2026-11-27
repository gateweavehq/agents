import { SANDBOX_REPOSITORY_PATH } from "@gateweave/agents-model";
import { describe, expect, it, vi } from "vitest";
import { answer, finding, HEAD, MERGE_BASE, setup } from "./review-fixture";

const failed = answer("first".repeat(200) + "tail".repeat(1000), 1);
const reset = `git reset --hard --quiet ${HEAD}`;
const compare = `compare ${HEAD.slice(0, 7)}`;
const runCommand = `run ${finding.test.command}`;
const earlier = "the checkout could not be put back at the reviewed head after an earlier proof";

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
		expect(sandbox.files.get(`${SANDBOX_REPOSITORY_PATH}/${finding.test.path}`)).toBe(
			finding.test.content,
		);
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
	it("records a sandbox failure as unproven and restores the checkout", async () => {
		const { sandbox, call } = setup();
		sandbox.answers.push(new Error("sandbox lost"));
		expect((await call()).findings[0]?.proof).toEqual({
			proven: false,
			reason: "the sandbox could not run the command",
		});
		expect(sandbox.log.slice(-3)).toEqual([reset, "git clean -fdq", compare]);
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
	it("stops waiting for a sandbox that never answers", async () => {
		vi.useFakeTimers();
		try {
			const { sandbox, call, record } = setup();
			vi.spyOn(sandbox, "run").mockImplementation(() => new Promise(() => {}));
			const pending = call();
			await vi.advanceTimersByTimeAsync(309_999);
			expect(record).not.toHaveBeenCalled();
			sandbox.clock += 310_000;
			await vi.advanceTimersByTimeAsync(1);
			expect((await pending).proofSeconds).toBe(310);
			expect((await pending).findings[0]?.proof).toEqual({
				proven: false,
				reason: "the command was stopped after 300 seconds",
			});
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
			expect(sandbox.files.size).toBe(0);
		},
	);
	it.each(["exit 1", "false", "pnpm test", "pnpm vitest run test/b.test.ts"])(
		"refuses a command that does not name the file: %s",
		async (command) => {
			const { call, sandbox } = setup();
			sandbox.answers.push(failed);
			expect(
				(await call([{ ...finding, test: { ...finding.test, command } }])).findings[0]?.proof,
			).toEqual({ proven: false, reason: "the command does not run the test file" });
			expect(sandbox.commands).toEqual([]);
		},
	);
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
		expect(sandbox.files.size).toBe(0);
		expect(sandbox.commands).toEqual([]);
	});
	it("counts a write error and cleans up without running the command", async () => {
		const { call, sandbox } = setup();
		vi.spyOn(sandbox, "writeFile").mockResolvedValue({ error: "read only" });
		expect(await call()).toMatchObject({
			proofsRun: 1,
			findings: [{ proof: { proven: false, reason: "the test file could not be written" } }],
		});
		expect(sandbox.commands).toEqual([]);
		expect(sandbox.log.slice(-3)).toEqual([reset, "git clean -fdq", compare]);
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
		const one = [reset, "git clean -fdq", runCommand, reset, "git clean -fdq", compare];
		expect(sandbox.log.slice(2)).toEqual([...one, ...one]);
	});
	it.each(["changed", "compare throws", "reset fails", "clean fails"])(
		"preserves the first proof and refuses the next when cleanup fails: %s",
		async (mode) => {
			const { call, sandbox } = setup();
			sandbox.answers.push(failed);
			if (mode === "changed") sandbox.changes.push({ changed: "dirty" });
			else if (mode === "compare throws") sandbox.changes.push(new Error("unavailable"));
			else {
				const normal = sandbox.gitAnswer;
				sandbox.gitAnswer = (args) =>
					sandbox.commands.length && args[0] === mode.split(" ")[0]
						? answer("", 1)
						: normal?.(args);
			}
			const { findings } = await call([finding, finding]);
			expect(findings[0]?.proof.proven).toBe(true);
			expect(findings[1]?.proof).toEqual({ proven: false, reason: earlier });
			expect(sandbox.commands).toHaveLength(1);
			expect(sandbox.log.at(-1)).toBe(compare);
		},
	);
	it("refuses subsequent proofs if restoring before a command failed", async () => {
		const { call, sandbox } = setup();
		const normal = sandbox.gitAnswer;
		sandbox.gitAnswer = (args) =>
			args[0] === "reset" ? new Error("lost checkout") : normal?.(args);
		const result = await call([finding, finding]);
		expect(result.proofsRun).toBe(1);
		expect(result.findings.map((f) => f.proof)).toEqual([
			{ proven: false, reason: "the checkout could not be put back at the reviewed head" },
			{ proven: false, reason: earlier },
		]);
		expect(sandbox.commands).toEqual([]);
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
