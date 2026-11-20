/**
 * A repository's checks before a pull request (AGT-142). Each test names the requirement of the
 * issue it holds the tool to. `open_pull_request` stands on a sandbox in memory, a GitHub that
 * records what it was asked to open, and settings a test can change between two calls.
 */
import { CHECK_LIMITS, type PullRequestOutcome } from "@gateweave/agents-model";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
	lastBytes,
	pullRequestBody,
	runChecks,
	SHORTENED,
	withChecksSection,
	withoutChecksSection,
} from "../src/checks";
import { pullRequestTools } from "../src/pull-requests";
import type { RunRecorder } from "../src/trace";
import { type CommandAnswer, MemorySandbox } from "./fake-sandbox";

const repository = {
	owner: "acme",
	name: "site",
	externalId: "7",
	installationId: "99",
	defaultBranch: "main",
};
const BRANCH = "gateweave/conversation-1";
const DISCLOSURE =
	"Written and opened by `Builder`, an AI agent in Gateweave Agents.\n<!-- AI-Disclosure: mode=machine-generated -->";
const AUTHOR = { name: "Builder", email: "noreply@gateweave.com" };
/** The line after a body with a tag in it: it ends a tag left open and is a comment otherwise. */
const TAG_CLOSER = `<!-- " ' -->`;

/** The sentence every section the tool writes ends with. */
const WRITTEN_BY =
	"The commands are set on the repository's page in Gateweave Agents. Gateweave wrote this section, not the agent: it is always the last one, and what stands above it is the agent's.";

const passed = (seconds = 0): CommandAnswer => ({
	exitCode: 0,
	output: "ok",
	timedOut: false,
	seconds,
});
const failed = (output = "1 test failed", exitCode = 1): CommandAnswer => ({
	exitCode,
	output,
	timedOut: false,
});

interface Span {
	server: string;
	tool: string;
	inputBytes: number;
	ended: { outputBytes?: number; error: string | null } | null;
}

/**
 * `open_pull_request` for a repository whose settings hold `commands`, which a test may change
 * between calls; `machine: false` is a turn without a sandbox to run them in.
 */
function setup(commands: string[], { machine = true }: { machine?: boolean } = {}) {
	const sandbox = new MemorySandbox();
	const settings = { commands, fail: false, asked: 0 };
	const proposed: { branch: string; title: string; body: string; draft?: boolean }[] = [];
	const recorded: PullRequestOutcome[] = [];
	const spans: Span[] = [];
	let open: number | null = null;
	const run = {
		targets: { tainted: false },
		toolStarted: (server: string, tool: string, inputBytes: number) => {
			spans.push({ server, tool, inputBytes, ended: null });
			return String(spans.length - 1);
		},
		toolEnded: (span: string, outcome: Span["ended"]) => {
			const started = spans[Number(span)];
			if (started) started.ended = outcome;
		},
	} as unknown as RunRecorder;
	const tools = pullRequestTools({
		sandbox,
		checks: {
			commands: async () => {
				settings.asked += 1;
				if (settings.fail) throw new Error("The registry did not answer");
				return settings.commands;
			},
			sandbox: machine ? sandbox : null,
			now: () => sandbox.clock,
		},
		ready: async () => null,
		github: {
			async propose(input) {
				proposed.push(input);
				const opened = open === null;
				open ??= 12;
				return {
					number: open,
					url: `https://github.com/acme/site/pull/${open}`,
					opened,
					title: input.title,
					state: "open",
					head: "2".repeat(40),
					headRef: input.branch,
					additions: 10,
					deletions: 3,
					changedFiles: 2,
				};
			},
		},
		repository,
		branch: BRANCH,
		agentName: "Builder",
		model: "model-1",
		author: async () => AUTHOR,
		record: async (outcome) => {
			recorded.push(outcome);
		},
		run,
	});
	const tool = tools.open_pull_request;
	const call = (
		input: object = { title: "Fix the cart", body: "It ignored codes." },
		abortSignal?: AbortSignal,
	) => {
		const execute = tool?.execute as
			| ((
					input: object,
					options: { toolCallId: string; messages: []; abortSignal?: AbortSignal },
			  ) => Promise<unknown>)
			| undefined;
		if (!execute) throw new Error("No open_pull_request");
		return execute(input, {
			toolCallId: "call-1",
			messages: [],
			abortSignal,
		}) as Promise<PullRequestOutcome>;
	};
	/** A call that is expected to open nothing: the message the model reads. */
	const refused = async (input?: object) => {
		const error = await call(input).then(
			() => null,
			(thrown: unknown) => thrown,
		);
		if (!(error instanceof Error)) throw new Error("The call opened a pull request");
		return error.message;
	};
	/** The spans of the checks, without the one of the tool itself. */
	const checkSpans = () => spans.filter((span) => span.tool === "check");
	return { sandbox, settings, proposed, recorded, spans, checkSpans, tool, call, refused };
}

describe("a repository without checks", () => {
	it("R1: is proposed as before: one commit and push, the disclosed body and nothing about checks", async () => {
		const { sandbox, proposed, recorded, spans, call } = setup([]);
		const outcome = await call();
		expect(outcome).toEqual({
			repository: "acme/site",
			number: 12,
			url: "https://github.com/acme/site/pull/12",
			opened: true,
			title: "Fix the cart",
			branch: BRANCH,
			state: "open",
			additions: 10,
			deletions: 3,
			changedFiles: 2,
			head: "1".repeat(40),
		});
		expect(sandbox.log).toEqual(["commit and push"]);
		expect(sandbox.commands).toEqual([]);
		expect(proposed).toEqual([
			{ branch: BRANCH, title: "Fix the cart", body: `It ignored codes.\n\n${DISCLOSURE}` },
		]);
		expect(recorded).toEqual([outcome]);
		expect(spans.map((span) => span.tool)).toEqual(["open_pull_request"]);

		// An update carries the disclosure too.
		const spaced = "  Indented.\n\n## How it was checked\n\nBy hand.  \n\n";
		await call({ title: "Fix the cart", body: spaced });
		expect(proposed[1]?.body).toBe(`${spaced}\n\n${DISCLOSURE}`);
	});

	it("R7: adds the disclosure when the tool is made without checks at all", async () => {
		const sandbox = new MemorySandbox();
		const proposed: object[] = [];
		const tools = pullRequestTools({
			sandbox,
			ready: async () => null,
			github: {
				async propose(input) {
					proposed.push(input);
					return {
						number: 3,
						url: "https://github.com/acme/site/pull/3",
						opened: true,
						title: input.title,
						state: "open",
						head: "2".repeat(40),
						headRef: input.branch,
						additions: 10,
						deletions: 3,
						changedFiles: 2,
					};
				},
			},
			repository,
			branch: BRANCH,
			agentName: "Builder",
			model: "model-1",
			author: async () => AUTHOR,
			record: async () => {},
			run: {
				targets: { tainted: false },
				toolStarted: () => "span",
				toolEnded: () => {},
			} as unknown as RunRecorder,
		});
		const execute = tools.open_pull_request?.execute as (
			input: object,
			options: object,
		) => Promise<unknown>;
		await execute({ title: "T", body: "B" }, { toolCallId: "call-1", messages: [] });
		expect(sandbox.log).toEqual(["commit and push"]);
		expect(proposed).toEqual([{ branch: BRANCH, title: "T", body: `B\n\n${DISCLOSURE}` }]);
	});
});

describe("a repository's checks", () => {
	it("a stream that never closes times out at the outer deadline and ends its span", async () => {
		vi.useFakeTimers();
		try {
			let rejectRun: ((error: Error) => void) | undefined;
			const ended: { error: string | null }[] = [];
			const spent = { failedRounds: 0, seconds: 0 };
			const running = runChecks(
				["pnpm test"],
				{
					run: () =>
						new Promise((_, reject) => {
							rejectRun = reject;
						}),
					changedSince: async () => null,
				},
				"1".repeat(40),
				{
					targets: { tainted: false },
					toolStarted: () => "span",
					toolEnded: (_span: string, result: { error: string | null }) => {
						ended.push(result);
					},
				} as unknown as RunRecorder,
				spent,
			);
			await vi.advanceTimersByTimeAsync((CHECK_LIMITS.commandSeconds + 10) * 1000);
			const round = await running;
			expect(round.status).toBe("failed");
			expect(round.results[0]?.outcome).toEqual({
				kind: "timed-out",
				limitSeconds: CHECK_LIMITS.commandSeconds,
			});
			expect(round.results[0]?.seconds).toBe(CHECK_LIMITS.commandSeconds + 10);
			expect(spent.seconds).toBe(CHECK_LIMITS.commandSeconds + 10);
			expect(ended).toEqual([
				{
					outputBytes: 0,
					error: `It timed out: it was stopped after ${CHECK_LIMITS.commandSeconds} seconds`,
				},
			]);
			rejectRun?.(new Error("stream closed late"));
			await Promise.resolve();
		} finally {
			vi.useRealTimers();
		}
	});
	it("R2: run in the repository's root on the commit, in order, before that commit is pushed", async () => {
		const { sandbox, proposed, call } = setup(["pnpm check", "pnpm test"]);
		const outcome = await call();

		// The checkout is compared with the commit after each check, and that commit is pushed.
		expect(sandbox.log).toEqual([
			"commit",
			"run pnpm check",
			"compare 1111111",
			"run pnpm test",
			"compare 1111111",
			"push 1111111",
		]);
		expect(sandbox.commits).toEqual([
			{ message: "Fix the cart", author: AUTHOR, model: "model-1" },
		]);
		expect(sandbox.commands).toEqual([
			{ command: "pnpm check", cwd: "/workspace/repo", timeoutSeconds: 600 },
			{ command: "pnpm test", cwd: "/workspace/repo", timeoutSeconds: 600 },
		]);
		// The commit that was checked is the one pushed: nothing is committed after the checks.
		expect(sandbox.commitPushes).toEqual([{ branch: BRANCH, head: "1".repeat(40) }]);
		expect(sandbox.pushes).toEqual([]);
		expect(outcome).toMatchObject({ opened: true, head: "1".repeat(40), checks: "passed" });
		expect(outcome.draft).toBe(false);
		expect(proposed).toHaveLength(1);
		expect(proposed[0]?.draft).toBeUndefined();
	});

	it("R2: a check that passes but changes the repository's files stops the round: the next would not run on the commit", async () => {
		const { sandbox, proposed, spans, call, refused } = setup([
			"pnpm format",
			"pnpm test",
			"git checkout .",
		]);
		// The formatter rewrote a file. The tests after it would run on that, not on the commit,
		// and a last command that puts the file back would leave nothing to see at the end: so
		// the checkout is compared after each check, and the round stops at the first difference.
		const status = " M src/cart.ts\n?? src/cart.test.ts.snap";
		sandbox.changes.push({ changed: status });
		const message = await refused();
		expect(sandbox.log).toEqual(["commit", "run pnpm format", "compare 1111111"]);
		expect(proposed).toEqual([]);
		expect(message).toContain("nothing was pushed and no pull request was opened or updated");
		expect(message).toContain(
			"`pnpm format` exited with 0, but after it the repository's files were not the commit's any more",
		);
		expect(message).toContain(status);
		expect(message).toContain("failed round 1 of 3");
		// The trace says why without naming a file, which is the agent's to choose.
		expect(spans[0]?.ended).toEqual({
			error:
				"The call failed: The repository's checks did not pass, so nothing was pushed. A check changed the repository's files, so they would not all have run on the commit",
		});

		// Called again, the tool commits what the formatter changed and checks that commit, which
		// the checks then leave as it is.
		expect(await call()).toMatchObject({ checks: "passed", draft: false, head: "2".repeat(40) });
		expect(sandbox.commitPushes).toEqual([{ branch: BRANCH, head: "2".repeat(40) }]);
		expect(proposed[0]?.body).not.toContain("different from this commit");
	});

	it("R2: a round that keeps changing the files ends as a draft that says so, without a file's name", async () => {
		const { sandbox, proposed, spans, call, refused } = setup(["pnpm format", "pnpm test"]);
		const status = " M secret-plan.md";
		// The second time the sandbox cannot say. That fails the round too, and is not called a
		// change: nobody saw one.
		sandbox.changes.push({ changed: status }, new Error("The container is gone"), {
			changed: status,
		});
		await refused();
		const unverified = await refused();
		expect(unverified).toContain(
			"`pnpm format` exited with 0, but whether the repository's files were still the commit's after it could not be told, so the round does not count as passed. The sandbox could not say whether the checkout is still the commit. Call the tool again.",
		);
		expect(unverified).not.toContain("The container is gone");
		expect(unverified).not.toContain("formatter that fixes them");
		expect(spans.filter((span) => span.tool === "open_pull_request").at(-1)?.ended).toEqual({
			error:
				"The call failed: The repository's checks did not pass, so nothing was pushed. Whether they ran on the commit could not be told",
		});

		const outcome = await call();
		expect(outcome).toMatchObject({ checks: "failed", draft: true });
		expect(outcome.note).toContain(status);
		expect(proposed).toHaveLength(1);
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain(
			[
				"- `pnpm format`: passed, exit code 0, 0.0 s\n- `pnpm test`: not run (an earlier check left the repository's files different from the commit)",
				"A check exited with 0 but left the repository's files different from this commit, so the checks did not all run on it as it is. That counts as a failed round.",
				"The checks failed in 3 rounds of this run, so Gateweave opens the pull request as a draft. One that was open already stays as it was.",
			].join("\n\n"),
		);
		expect(proposed[0]?.body).not.toContain("secret-plan");
	});

	it("R2: a draft after rounds that could not be compared says that, and not that a check changed files", async () => {
		const { sandbox, proposed, call, refused } = setup(["pnpm test", "pnpm build"]);
		const lost = { unverified: "The checkout's changes could not be read." };
		sandbox.changes.push(lost, lost, lost);
		await refused();
		await refused();
		expect(await call()).toMatchObject({ checks: "failed", draft: true });
		const body = proposed[0]?.body ?? "";
		expect(body).toContain(
			[
				"- `pnpm test`: passed, exit code 0, 0.0 s\n- `pnpm build`: not run (it could not be told whether the repository's files were still the commit's)",
				"A check exited with 0, but Gateweave could not make sure that the repository's files were still this commit's afterwards. That counts as a failed round.",
			].join("\n\n"),
		);
		expect(body).not.toContain("left the repository's files different");
		expect(sandbox.commands.map(({ command }) => command)).toEqual([
			"pnpm test",
			"pnpm test",
			"pnpm test",
		]);
	});

	it("R5: two calls at once take their turns, each with its own commit, checks and push", async () => {
		const { sandbox, proposed, call } = setup(["pnpm test"]);
		const [first, second] = await Promise.all([
			call({ title: "One", body: "First." }),
			call({ title: "Two", body: "Second." }),
		]);
		expect(sandbox.log).toEqual([
			"commit",
			"run pnpm test",
			"compare 1111111",
			"push 1111111",
			"commit",
			"run pnpm test",
			"compare 2222222",
			"push 2222222",
		]);
		expect([first.head, second.head]).toEqual(["1".repeat(40), "2".repeat(40)]);
		expect(proposed.map(({ title }) => title)).toEqual(["One", "Two"]);

		// One that fails does not hold up the next.
		sandbox.answers.push({ exitCode: 1, output: "red", timedOut: false });
		const [failed, passed] = await Promise.allSettled([call(), call()]);
		expect(failed.status).toBe("rejected");
		expect(passed.status).toBe("fulfilled");
	});

	it("R5: a call that waited its turn while the turn was stopped does not begin, with checks or without", async () => {
		for (const commands of [["pnpm test"], []]) {
			const { sandbox, proposed, call } = setup(commands);
			const turn = new AbortController();
			const first = call({ title: "One", body: "First." });
			const second = call({ title: "Two", body: "Second." }, turn.signal);
			turn.abort();
			await first;
			await expect(second).rejects.toMatchObject({ name: "AbortError" });
			expect(sandbox.commits.length + sandbox.pushes.length).toBe(1);
			expect(proposed.map(({ title }) => title)).toEqual(["One"]);
		}
	});

	it("R2: nothing is committed twice, pushed or opened when the commit itself fails", async () => {
		const { sandbox, proposed, refused } = setup(["pnpm test"]);
		sandbox.commitAnswers.push({
			error: "There is nothing to propose: the work has no commit that main does not.",
		});
		expect(await refused()).toContain("There is nothing to propose");
		expect(sandbox.log).toEqual(["commit"]);
		expect(proposed).toEqual([]);
	});

	it("R2: a turn stopped while the checks run starts no further check, and pushes and opens nothing", async () => {
		const { sandbox, proposed, spans, call } = setup(["pnpm check", "pnpm test"]);
		const turn = new AbortController();
		// The turn is stopped while the first check runs, which goes on to its end and passes.
		const run = sandbox.run.bind(sandbox);
		vi.spyOn(sandbox, "run").mockImplementationOnce((...asked) => {
			turn.abort();
			return run(...asked);
		});
		await expect(call(undefined, turn.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(sandbox.log).toEqual(["commit", "run pnpm check"]);
		expect(proposed).toEqual([]);
		expect(spans[0]?.ended).toEqual({ error: "The turn was stopped" });

		// Stopped while the last check runs, which passes: still nothing leaves the sandbox.
		const last = setup(["pnpm test"]);
		const stopped = new AbortController();
		const runLast = last.sandbox.run.bind(last.sandbox);
		vi.spyOn(last.sandbox, "run").mockImplementationOnce((...asked) => {
			stopped.abort();
			return runLast(...asked);
		});
		await expect(last.call(undefined, stopped.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(last.sandbox.log).toEqual(["commit", "run pnpm test"]);
		expect(last.proposed).toEqual([]);
	});

	it("R2: a turn stopped during checkout comparison pushes and proposes nothing", async () => {
		const compared = setup(["pnpm test"]);
		const late = new AbortController();
		vi.spyOn(compared.sandbox, "changedSince").mockImplementationOnce(async () => {
			late.abort();
			return null;
		});
		await expect(compared.call(undefined, late.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(compared.sandbox.log).toEqual(["commit", "run pnpm test"]);
		expect(compared.sandbox.commitPushes).toEqual([]);
		expect(compared.proposed).toEqual([]);
	});

	it("R3: a failed check opens nothing and pushes nothing, and tells the model what failed", async () => {
		const { sandbox, proposed, recorded, refused } = setup(["pnpm check", "pnpm test"]);
		sandbox.answers.push(passed(), failed("FAIL cart.test.ts\n1 test failed", 2));
		const message = await refused();

		expect(sandbox.commitPushes).toEqual([]);
		expect(sandbox.pushes).toEqual([]);
		expect(proposed).toEqual([]);
		expect(recorded).toEqual([]);
		expect(message).toContain("nothing was pushed and no pull request was opened or updated");
		expect(message).toContain("`pnpm test`: It exited with code 2, after 0.0 s.");
		expect(message).toContain("FAIL cart.test.ts\n1 test failed");
		expect(message).toContain("failed round 1 of 3");
		// The check that passed is not the model's to fix, so it is not named.
		expect(message).not.toContain("pnpm check");
	});

	it("R3: stop at the first that fails", async () => {
		const { sandbox, refused } = setup(["pnpm check", "pnpm typecheck", "pnpm test"]);
		sandbox.answers.push(failed());
		await refused();
		expect(sandbox.commands.map(({ command }) => command)).toEqual(["pnpm check"]);
	});

	it("R3: any exit code but 0 fails, and a sandbox that cannot run the command does too", async () => {
		const { sandbox, proposed, call, refused } = setup(["pnpm test"]);
		sandbox.answers.push(failed("", 255), new Error("The container is gone"));
		expect(await refused()).toContain("It exited with code 255, after 0.0 s. It printed nothing.");
		const message = await refused();
		expect(message).toContain("`pnpm test`: The sandbox could not run it");
		// What the sandbox threw is not the model's to read.
		expect(message).not.toContain("The container is gone");
		expect(proposed).toEqual([]);

		// The third round fails the same way, and the draft's section says so, without an exit code.
		sandbox.answers.push(new Error("The container is gone"));
		expect(await call()).toMatchObject({ checks: "failed", draft: true });
		expect(proposed[0]?.body).toContain(
			"- `pnpm test`: failed, no exit code: the sandbox could not run it, 0.0 s",
		);
		expect(proposed[0]?.body).not.toContain("The container is gone");
	});

	it("R3: a second round that passes opens the pull request, and not as a draft", async () => {
		const { sandbox, proposed, call, refused } = setup(["pnpm test"]);
		sandbox.answers.push(failed());
		await refused();
		const outcome = await call({ title: "Fix the cart, and its test", body: "Now it passes." });

		expect(outcome).toMatchObject({ opened: true, checks: "passed", draft: false });
		expect(outcome.note).toBeUndefined();
		// The second commit is the one pushed: the first never left the sandbox.
		expect(sandbox.commitPushes).toEqual([{ branch: BRANCH, head: "2".repeat(40) }]);
		expect(proposed).toHaveLength(1);
		expect(proposed[0]?.draft).toBeUndefined();
		expect(proposed[0]?.body).toContain("- `pnpm test`: passed, exit code 0, 0.0 s");
	});

	it("R3: the third failed round of a run pushes the work and opens a draft that says which check failed", async () => {
		const { sandbox, proposed, recorded, call, refused } = setup(["pnpm check", "pnpm test"]);
		sandbox.answers.push(passed(), failed(), passed(), failed(), passed(2), failed("still red", 1));
		expect(await refused()).toContain("failed round 1 of 3");
		expect(await refused()).toContain(
			"failed round 2 of 3 in this run: if the next one fails too, the pull request is opened as a draft",
		);
		expect(proposed).toEqual([]);
		expect(sandbox.commitPushes).toEqual([]);

		// The run is not failed for it: the tool answers, with the pull request.
		const outcome = await call();
		expect(outcome).toMatchObject({
			number: 12,
			opened: true,
			head: "3".repeat(40),
			checks: "failed",
			draft: true,
		});
		expect(outcome.note).toContain("failed in 3 rounds of this run");
		expect(outcome.note).toContain("`pnpm test`: It exited with code 1");
		expect(outcome.note).toContain("still red");
		expect(sandbox.commitPushes).toEqual([{ branch: BRANCH, head: "3".repeat(40) }]);
		expect(recorded).toEqual([outcome]);
		expect(proposed).toEqual([
			{
				branch: BRANCH,
				title: "Fix the cart",
				draft: true,
				body: [
					"It ignored codes.",
					"## Checks run by Gateweave",
					"Gateweave Agents ran these commands in the agent's sandbox on commit 3333333, before pushing it.",
					"- `pnpm check`: passed, exit code 0, 2.0 s\n- `pnpm test`: failed, exit code 1, 0.0 s",
					"The checks failed in 3 rounds of this run, so Gateweave opens the pull request as a draft. One that was open already stays as it was.",
					WRITTEN_BY,
					DISCLOSURE,
				].join("\n\n"),
			},
		]);
	});

	it("R3: after the draft, a round that passes updates the pull request with what passed", async () => {
		const { sandbox, proposed, call, refused } = setup(["pnpm test"]);
		sandbox.answers.push(failed(), failed(), failed());
		await refused();
		await refused();
		await call();
		const outcome = await call();
		expect(outcome).toMatchObject({ opened: false, checks: "passed", draft: false });
		expect(proposed).toHaveLength(2);
		expect(proposed[1]?.body).toContain("- `pnpm test`: passed, exit code 0, 0.0 s");
		expect(proposed[1]?.body).not.toContain("as a draft");
	});

	it("R3: the model reads the end of a failed command's output, 4,000 bytes at most, and the pull request and the trace none of it", async () => {
		const { sandbox, proposed, spans, call, refused } = setup(["pnpm test"]);
		const noise = "SECRET-OUTPUT ".repeat(1_000);
		const output = `${noise}THE-START-IS-CUT\n${"é".repeat(1_990)}THE-END`;
		sandbox.answers.push(failed(output), failed(output), failed(output));
		const message = await refused();
		expect(message).toContain("THE-END");
		expect(message).not.toContain("THE-START-IS-CUT");
		const tail = message.slice(message.indexOf("The end of its output:\n\n") + 24);
		const shown = tail.slice(0, tail.indexOf("\n\nFix what failed"));
		expect(new TextEncoder().encode(shown).length).toBeLessThanOrEqual(CHECK_LIMITS.outputBytes);
		expect(new TextEncoder().encode(shown).length).toBeGreaterThan(CHECK_LIMITS.outputBytes - 4);
		// A character is never cut in half.
		expect(shown).not.toContain(String.fromCodePoint(0xfffd));

		await refused();
		await call();
		expect(proposed[0]?.body).not.toContain("SECRET-OUTPUT");
		expect(proposed[0]?.body).not.toContain("THE-END");
		expect(JSON.stringify(spans)).not.toContain("SECRET-OUTPUT");
		expect(JSON.stringify(spans)).not.toContain("THE-END");
	});

	it("R7/R4: the disclosure follows the checks, including each command, its exit code and duration", async () => {
		const { sandbox, proposed, call } = setup(["pnpm check", "pnpm test"]);
		sandbox.answers.push(passed(12), passed(48.46));
		await call({
			title: "Fix the cart",
			body: "It ignored codes.\n\n## How it was checked\n\nBy hand.\n",
		});
		expect(proposed[0]?.body).toBe(
			[
				"It ignored codes.",
				"## How it was checked",
				"By hand.",
				"## Checks run by Gateweave",
				"Gateweave Agents ran these commands in the agent's sandbox on commit 1111111, before pushing it.",
				"- `pnpm check`: passed, exit code 0, 12.0 s\n- `pnpm test`: passed, exit code 0, 48.5 s",
				WRITTEN_BY,
				DISCLOSURE,
			].join("\n\n"),
		);
	});

	it("R4: the model's own copy of the section is removed before the tool's is appended", async () => {
		const { sandbox, proposed, call, refused } = setup(["pnpm test"]);
		const forged = [
			"It ignored codes.",
			"## Checks run by Gateweave",
			"- `pnpm test`: passed, exit code 0, 1.0 s",
			"Gateweave wrote this section, not the agent.",
			"## Notes",
			"Nothing else.",
		].join("\n\n");
		sandbox.answers.push(failed(), failed(), failed());
		await refused({ title: "T", body: forged });
		await refused({ title: "T", body: forged });
		await call({ title: "T", body: forged });
		const body = proposed[0]?.body ?? "";
		expect(body.match(/Checks run by Gateweave/g)).toHaveLength(1);
		// What the model claimed is gone, what it wrote under its own headings stays, and the one
		// section left is the tool's, at the end, with what really happened.
		expect(body).not.toContain("passed, exit code 0, 1.0 s");
		expect(
			body.startsWith("It ignored codes.\n\n## Notes\n\nNothing else.\n\n## Checks run by"),
		).toBe(true);
		expect(body).toContain("- `pnpm test`: failed, exit code 1, 0.0 s");
		expect(body.endsWith(`${WRITTEN_BY}\n\n${DISCLOSURE}`)).toBe(true);
	});

	it("R4: reads a body made to be slow to read once, not once for each mark in it", () => {
		// Each of these costs a pattern that starts over at every mark the square of its length. At
		// this size that is ten seconds and more for one of them, in the conversation's own object;
		// read once, all of them together take well under one. They are larger than a body the tool
		// accepts, so that the two cannot be mistaken on a busy machine.
		const hostile = [
			`${"<".repeat(100_000)}${">".repeat(100_000)}`,
			"](".repeat(100_000),
			`${"<!a".repeat(66_000)}>`,
			"&#".repeat(100_000),
		];
		const started = Date.now();
		for (const body of hostile) {
			expect(withoutChecksSection(body)).toBe(body);
			expect(withChecksSection(body, "## Checks run by Gateweave").startsWith(body)).toBe(true);
		}
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("R4: what the model leaves open is closed before the tool's section, so the section is neither hidden nor shown as code", () => {
		const section = "## Checks run by Gateweave\n\nx";
		const after = (body: string) => {
			const whole = withChecksSection(body, section);
			expect(whole.endsWith(`\n\n${section}`), body).toBe(true);
			return whole.slice(0, -section.length - 2);
		};
		// A body that leaves nothing open is followed by the section and nothing else.
		for (const whole of [
			"Done.",
			"```sh\npnpm test\n```",
			"~~~\n```\n~~~",
			"Done. <!-- a note --> And more.",
			"<?php echo 1; ?> and <![CDATA[x]]> and <!DOCTYPE html>",
			// A line of backticks inside a comment is the comment's own: a closer after the comment
			// would open a code block there, with the section in it.
			"Done.\n\n<!--\n```\nnot shown\n-->\n\nMore.",
			"<!-- one line ``` -->\n```\ncode\n```",
		]) {
			expect(after(whole), whole).toBe(whole);
		}
		// A fence opened after such a comment is a fence, and is closed.
		expect(after("<!--\n```\n-->\n```js\nconst open = true;")).toBe(
			"<!--\n```\n-->\n```js\nconst open = true;\n```",
		);
		// A comment, a processing instruction, CDATA or a declaration left open would take the
		// section in, and a page shows nothing of what is inside one.
		expect(after("All checks passed.\n\n<!--")).toBe("All checks passed.\n\n<!--\n-->");
		expect(after("<!-- one --> and <!-- two")).toBe("<!-- one --> and <!-- two\n-->");
		expect(after("Passed.\n\n<?")).toBe("Passed.\n\n<?\n?>");
		expect(after("Passed.\n\n<![CDATA[")).toBe("Passed.\n\n<![CDATA[\n]]>");
		expect(after("Passed.\n\n<!DOCTYPE")).toBe("Passed.\n\n<!DOCTYPE\n>");
		// A text with a tag in it is followed by a line that ends any tag left open and is a
		// comment otherwise, so it shows nothing even after a block that leaves nothing open.
		expect(after("<details><summary>Log</summary>\n\nok\n\n</details>")).toBe(
			`<details><summary>Log</summary>\n\nok\n\n</details>\n${TAG_CLOSER}`,
		);
		// A folded block left open would fold the section away.
		expect(after("<details><summary>Checks passed</summary>")).toBe(
			`<details><summary>Checks passed</summary>\n${TAG_CLOSER}\n</details>`,
		);
		expect(after("<DETAILS open>\n<details>\n</details>\n<details >")).toBe(
			`<DETAILS open>\n<details>\n</details>\n<details >\n${TAG_CLOSER}\n</details>\n</details>`,
		);
		// A code block left open would show the section as part of the model's code.
		expect(after("Passed:\n\n```")).toBe("Passed:\n\n```\n```");
		expect(after("````md\n```\nstill open")).toBe("````md\n```\nstill open\n````");
		expect(after("   ~~~~ text\n~~~\n")).toBe("   ~~~~ text\n~~~\n~~~~");
		expect(after("Done.\n\n<pre>unclosed")).toBe(`Done.\n\n<pre>unclosed\n${TAG_CLOSER}\n</pre>`);
		// Several at once: each gets its closer.
		expect(after("```\n<!--\n<details>")).toBe(
			`\`\`\`\n<!--\n<details>\n\`\`\`\n-->\n${TAG_CLOSER}\n</details>`,
		);
	});

	it("R4: a tag the model leaves unfinished is ended before the tool's section, and only one line is added however often the body comes back", () => {
		const section = "## Checks run by Gateweave\n\nx";
		const after = (body: string) => withChecksSection(body, section).slice(0, -section.length - 2);
		// An HTML block passes the tag on as it is, and its open value would take the section in.
		expect(after('Done.\n\n<div title="unfinished')).toBe(
			`Done.\n\n<div title="unfinished\n${TAG_CLOSER}`,
		);
		expect(after("<pre title='unfinished")).toBe(`<pre title='unfinished\n${TAG_CLOSER}\n</pre>`);
		expect(after("<div>\n<span title=unfinished")).toBe(
			`<div>\n<span title=unfinished\n${TAG_CLOSER}`,
		);
		// Text Markdown escapes cannot be told from a tag by reading the source alone: here the
		// quote that opens in the paragraph ends in the <div>, whose own quote stays open.
		expect(after('A <b a="\n\n<div title=">')).toBe(`A <b a="\n\n<div title=">\n${TAG_CLOSER}`);
		// A body the tool wrote before, sent back, keeps the lines it had: the one before the
		// </details> now in the text ends any tag the model left open there, and one more ends
		// the text. Sent back again, it stays as it is.
		const once = withChecksSection("<details>\nLog", section);
		const twice = withChecksSection(once, section);
		expect(twice).toBe(`<details>\nLog\n${TAG_CLOSER}\n</details>\n${TAG_CLOSER}\n\n${section}`);
		expect(withChecksSection(twice, section)).toBe(twice);
		// So a <details> whose own tag the model left unfinished is still ended before its
		// </details>, which would otherwise fall inside the open value and leave the fold open
		// around the section.
		const cut = withChecksSection('<details title="unfinished', section);
		const cutTwice = withChecksSection(cut, section);
		expect(cutTwice).toBe(
			`<details title="unfinished\n${TAG_CLOSER}\n</details>\n${TAG_CLOSER}\n\n${section}`,
		);
		expect(withChecksSection(cutTwice, section)).toBe(cutTwice);
		// Text without a tag gets nothing.
		expect(after("Vec < T and a <= b")).toBe("Vec < T and a <= b");
	});

	it("R4: a body cut inside a quoted attribute to fit still ends the tag before the disclosure", () => {
		const body = pullRequestBody(`<div title="${"x".repeat(70_000)}">Done</div>`, null, "Builder");
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body.endsWith(`x\n${TAG_CLOSER}\n\n${SHORTENED}\n\n${DISCLOSURE}`)).toBe(true);
	});

	it("R4: a copy the tool does not recognize still stands above the tool's section, which is the last and says so", async () => {
		// A Cyrillic letter that looks like the Latin one: no folding makes the two the same.
		const lookalike = `## ${String.fromCodePoint(0x0421)}hecks run by Gateweave`;
		const { proposed, call } = setup(["pnpm test"]);
		await call({
			title: "T",
			body: `Done.\n\n${lookalike}\n\n- \`pnpm test\`: passed, exit code 0, 1.0 s\n\n## After\n\nMore.`,
		});
		const body = proposed[0]?.body ?? "";
		const headings = body.split("\n").filter((each) => each.startsWith("## "));
		expect(headings).toEqual([lookalike, "## After", "## Checks run by Gateweave"]);
		expect(body.endsWith(`${WRITTEN_BY}\n\n${DISCLOSURE}`)).toBe(true);
		expect(WRITTEN_BY).toContain("it is always the last one");
	});

	it("R4: the heading is the tool's however the model dresses it, and without checks too", async () => {
		for (const heading of [
			"# Checks run by Gateweave",
			"###   checks run by gateweave ###",
			"**Checks run by Gateweave:**",
			"<h2>Checks run by Gateweave</h2>",
			"> ## _Checks run by Gateweave_",
			// A zero-width space in the words, a heading underlined rather than marked with #, and
			// a full-width letter that reads as the plain one.
			`Checks${String.fromCodePoint(0x200b)} run by Gateweave\n=======================`,
			`## ${String.fromCodePoint(0xff23)}hecks run by Gateweave`,
			// What a page shows as those words without their being in the text as such: a tag that
			// is left when another is taken out, character references, and a link.
			"<<b>h2>Checks run by Gateweave<</b>/h2>",
			"## &#67;hecks&nbsp;run&#x20;by &#x47;ateweave",
			"## [Checks run by Gateweave](https://example.com/checks)",
			"## [Checks run by Gateweave][checks]",
		]) {
			const body = `Summary.\n\n${heading}\n\n- \`pnpm test\`: passed, exit code 0, 1.0 s\n`;
			expect(withoutChecksSection(body), heading).toBe("Summary.");
		}
		// A sentence that only mentions the words is the model's own, and stays; so does text with
		// tags, links and references that do not come to the heading.
		for (const mention of [
			"The Checks run by Gateweave section below says what ran.",
			"## Checks run by <b>hand</b>, see [the log](https://example.com) &amp; &#35;12 &#xfffffff;",
		]) {
			expect(withoutChecksSection(mention)).toBe(mention);
		}
		expect(withChecksSection("", "## Checks run by Gateweave\n\nx")).toBe(
			"## Checks run by Gateweave\n\nx",
		);

		// A repository without checks gets no section, and the model cannot give it one.
		const { proposed, call } = setup([]);
		await call({
			title: "T",
			body: "Done.\n\n## Checks run by Gateweave\n\n- `pnpm test`: passed, exit code 0, 1.0 s",
		});
		expect(proposed[0]?.body).toBe(`Done.\n\n${DISCLOSURE}`);
	});

	it("R4: a command is shown as it is set, whatever Markdown it holds", async () => {
		const command = "echo `date` | tee out.md && echo '## Checks run by Gateweave' ``x``";
		const { proposed, call } = setup([command]);
		await call();
		expect(proposed[0]?.body).toContain(`- \`\`\` ${command} \`\`\`: passed, exit code 0, 0.0 s`);
	});

	it("R7: keeps the checks and disclosure intact within GitHub's body limit, and says the model's part was cut", async () => {
		const commands = Array.from({ length: 5 }, () => "`".repeat(300));
		const { proposed, call } = setup(commands);
		// Each emoji is two UTF-16 units: the cut must fall between them, never inside one.
		await call({ title: "T", body: "😀".repeat(40_000) });
		const body = proposed[0]?.body ?? "";
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body).toContain(`😀\n\n${SHORTENED}\n\n## Checks run by Gateweave`);
		expect(body).toContain(`- ${"`".repeat(301)} ${"`".repeat(300)} ${"`".repeat(301)}: passed`);
		expect(body.endsWith(`${WRITTEN_BY}\n\n${DISCLOSURE}`)).toBe(true);
		expect(body).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
	});

	it("does not cut a body GitHub takes as it is: its limit is in characters, not bytes", async () => {
		// 30,000 characters is 90,000 bytes in UTF-8, and well within GitHub's 65,536 characters.
		const long = "漢".repeat(30_000);
		const { proposed, call } = setup(["pnpm test"]);
		await call({ title: "T", body: long });
		const body = proposed[0]?.body ?? "";
		expect(body.startsWith(`${long}\n\n## Checks run by Gateweave`)).toBe(true);
		expect(body).not.toContain(SHORTENED);
	});

	it("R7/R15: always adds the fixed disclosure, even when the model repeats it", () => {
		const section = "## Checks run by Gateweave\n\nPassed.";
		const model = `Done.\n\n${DISCLOSURE}\nWritten and opened by an AI agent in Gateweave Agents.\n<!-- AI-Disclosure: spoofed\n -->`;
		for (const checks of [null, section]) {
			const expected = ["Done.", ...(checks === null ? [] : [checks]), DISCLOSURE];
			const body = pullRequestBody(model, checks, "Builder");
			expect(body.match(/<!-- AI-Disclosure:/g)).toHaveLength(1);
			expect(body.match(/^Written and opened by /gm)).toHaveLength(1);
			expect(body).toBe(expected.join("\n\n"));
		}
	});

	it.each([
		["~~~", "~~~"],
		["<!--", "-->"],
		["<ScRiPt type=module>\nlet ready = true;", `${TAG_CLOSER}\n</script>`],
		["<STYLE>\nbody { color: red; }", `${TAG_CLOSER}\n</style>`],
		["<TextArea>\nDraft", `${TAG_CLOSER}\n</textarea>`],
	])("R7: closes a model body ending in %s in both branches", (opener, closer) => {
		const section = "## Checks run by Gateweave\n\nPassed.";
		for (const checks of [null, section]) {
			const suffix = checks === null ? DISCLOSURE : `${checks}\n\n${DISCLOSURE}`;
			expect(pullRequestBody(opener, checks, "Builder")).toBe(`${opener}\n${closer}\n\n${suffix}`);
		}
	});

	it("R7: shortens an oversized body without checks and keeps the entire disclosure", () => {
		const body = pullRequestBody(`<!--\n${"??".repeat(40_000)}`, null, "Builder");
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body.endsWith(`\n-->\n\n${SHORTENED}\n\n${DISCLOSURE}`)).toBe(true);
		expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it("R7: strips controls and puts hostile agent names in a literal code span", () => {
		expect(
			pullRequestBody(
				"",
				null,
				"  Builder #1 @octocat https://x.test `<!--`\n\r\u0000\u001b\u2028\u2029\u202e  ",
			),
		).toBe(DISCLOSURE.replace("`Builder`", "`Builder #1 @octocat https://x.test <!--`"));
	});

	it("R7: falls back to a generic byline when the agent name cleans to empty", () => {
		expect(pullRequestBody("", null, " `\r\n\u202e ")).toBe(DISCLOSURE.replace("`Builder`, ", ""));
	});

	it("R7: caps the cleaned agent name at 100 characters", () => {
		const name = "\u{1F600}".repeat(100);
		expect(pullRequestBody("", null, `\`${name}x`)).toBe(DISCLOSURE.replace("Builder", name));
	});

	it("R5: a check stopped at its time limit is timed out, never passed, whatever its exit code", async () => {
		const { sandbox, proposed, call, refused } = setup(["pnpm test", "pnpm build"]);
		const stopped: CommandAnswer = {
			exitCode: 0,
			output: "still running",
			timedOut: true,
			seconds: 600,
		};
		sandbox.answers.push(stopped, stopped, stopped);
		const message = await refused();
		expect(message).toContain(
			"`pnpm test`: It timed out: it was stopped after 600 seconds, after 600.0 s.",
		);
		expect(proposed).toEqual([]);
		await refused();
		await call();
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain(
			"- `pnpm test`: timed out, no exit code, stopped after 600.0 s (limit 600 s)\n- `pnpm build`: not run (an earlier check did not pass)",
		);
	});

	it("R5: a check gets 10 minutes at most, and no more than is left of the call's 20", async () => {
		const { sandbox, proposed, refused } = setup(["a", "b", "c", "d"]);
		sandbox.answers.push(passed(600), passed(500), {
			exitCode: 143,
			output: "",
			timedOut: true,
			seconds: 100,
		});
		const message = await refused();
		expect(sandbox.commands.map(({ timeoutSeconds }) => timeoutSeconds)).toEqual([600, 600, 100]);
		expect(message).toContain("`c`: It timed out: it was stopped after 100 seconds");
		expect(proposed).toEqual([]);
	});

	it("R5: checks the call has no time left for are not run, and the round fails", async () => {
		const { sandbox, proposed, refused } = setup(["a", "b", "c"]);
		sandbox.answers.push(passed(600), passed(600));
		const message = await refused();
		expect(sandbox.commands.map(({ command }) => command)).toEqual(["a", "b"]);
		expect(message).toContain(
			"`c`: It was not run: the 20 minutes one call has for checks were used up.",
		);
		expect(message).toContain("failed round 1 of 3");
		expect(proposed).toEqual([]);
	});

	it("R5: a run's checks get 40 minutes together; after that they are not run, and the pull request says so as a draft", async () => {
		const { sandbox, proposed, call, refused } = setup(["a", "b"]);
		// Two rounds of 19 and a half minutes each leave one minute of the run's forty.
		sandbox.answers.push(passed(600), {
			exitCode: 1,
			output: "red",
			timedOut: false,
			seconds: 570,
		});
		await refused();
		sandbox.answers.push(passed(600), passed(570));
		expect(await call()).toMatchObject({ checks: "passed", draft: false });

		// The third round has the minute that is left, and uses it up.
		sandbox.answers.push({ exitCode: 124, output: "", timedOut: true, seconds: 60 });
		const message = await refused();
		expect(sandbox.commands.at(-1)).toMatchObject({ command: "a", timeoutSeconds: 60 });
		expect(message).toContain("`a`: It timed out: it was stopped after 60 seconds");

		// Nothing is left: no command starts, and the work is proposed as a draft that says why.
		const ran = sandbox.commands.length;
		const outcome = await call();
		expect(sandbox.commands).toHaveLength(ran);
		expect(outcome).toMatchObject({ opened: false, checks: "not run", draft: true });
		expect(outcome.note).toContain("the 40 minutes a run has for checks were used up");
		expect(proposed.at(-1)).toMatchObject({ draft: true });
		expect(proposed.at(-1)?.body).toContain(
			[
				"## Checks run by Gateweave",
				"Checks: not run (the 40 minutes a run has for checks were used up).",
				"- `a`: not run (the 40 minutes a run has for checks were used up)\n- `b`: not run (the 40 minutes a run has for checks were used up)",
				"The checks could not run, so Gateweave opens the pull request as a draft. One that was open already stays as it was.",
				WRITTEN_BY,
				DISCLOSURE,
			].join("\n\n"),
		);
	});

	it("R5: each check is a span of the sandbox's in the run's trace, with its sizes and why it failed", async () => {
		const { sandbox, spans, checkSpans, refused, call } = setup(["pnpm check", "pnpm test"]);
		sandbox.answers.push(passed(), failed("1 test failed", 1));
		await refused();
		expect(checkSpans()).toEqual([
			{ server: "sandbox", tool: "check", inputBytes: 10, ended: { outputBytes: 2, error: null } },
			{
				server: "sandbox",
				tool: "check",
				inputBytes: 9,
				ended: { outputBytes: 13, error: "It exited with code 1" },
			},
		]);
		// The tool's own span says the checks failed, and which, without a command's output.
		expect(spans[0]).toMatchObject({
			tool: "open_pull_request",
			ended: {
				error:
					"The call failed: The repository's checks did not pass, so nothing was pushed. Check 2: It exited with code 1",
			},
		});
		await call();
		expect(checkSpans()).toHaveLength(4);
		expect(checkSpans().every((span) => span.ended !== null)).toBe(true);
	});

	it("R6: are the repository's settings as they are at each call: a list changed between rounds is the one that runs", async () => {
		const { sandbox, settings, proposed, call, refused } = setup(["pnpm test"]);
		sandbox.answers.push(failed());
		await refused();
		expect(settings.asked).toBe(1);

		// An owner or admin changes the list while the agent works on. The count of failed rounds
		// is the run's, whatever the list.
		settings.commands = ["pnpm lint", "pnpm test:unit"];
		sandbox.answers.push(passed(), failed());
		expect(await refused()).toContain("failed round 2 of 3");
		expect(settings.asked).toBe(2);
		expect(sandbox.commands.map(({ command }) => command)).toEqual([
			"pnpm test",
			"pnpm lint",
			"pnpm test:unit",
		]);

		// Taken away, the next call is that of a repository without checks.
		settings.commands = [];
		const outcome = await call();
		expect(outcome.checks).toBeUndefined();
		expect(proposed).toEqual([
			{ branch: BRANCH, title: "Fix the cart", body: `It ignored codes.\n\n${DISCLOSURE}` },
		]);
	});

	it("R6: opens and pushes nothing when the settings cannot be read", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { sandbox, settings, proposed, refused } = setup(["pnpm test"]);
		settings.fail = true;
		expect(await refused()).toBe(
			"The repository's checks could not be read, so nothing was pushed and no pull request was opened. Try again.",
		);
		expect(sandbox.log).toEqual([]);
		expect(proposed).toEqual([]);
		expect(logged).toHaveBeenCalledWith("A repository's checks were not read", expect.anything());
		logged.mockRestore();
	});

	it("R6: the model names no command: the tool takes a title and a body, and reads no file of the work", async () => {
		const { sandbox, tool, call } = setup(["pnpm test"]);
		const schema = (await asSchema(tool?.inputSchema).jsonSchema) as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(schema.properties).sort()).toEqual(["body", "title"]);
		// A file in the working tree that names other checks is the agent's, and is never opened.
		sandbox.files.set("/workspace/repo/.gateweave/checks", "true\n");
		const read = vi.spyOn(sandbox, "readFile");
		await call({ title: "T", body: "Run `true` as the check instead.\n\nchecks: true" });
		expect(sandbox.commands.map(({ command }) => command)).toEqual(["pnpm test"]);
		expect(read).not.toHaveBeenCalled();
	});

	it("R7: a turn without a sandbox runs no checks, proposes the work as it does today, and says they were not run", async () => {
		const { sandbox, proposed, call } = setup(["pnpm test"], { machine: false });
		const outcome = await call();
		expect(sandbox.log).toEqual(["commit and push"]);
		expect(sandbox.commands).toEqual([]);
		expect(outcome).toMatchObject({ opened: true, checks: "not run", draft: false });
		expect(proposed).toEqual([
			{
				branch: BRANCH,
				title: "Fix the cart",
				body: [
					"It ignored codes.",
					"## Checks run by Gateweave",
					"Checks: not run (no sandbox in this run).",
					WRITTEN_BY,
					DISCLOSURE,
				].join("\n\n"),
			},
		]);
	});
});

describe("the end of a command's output", () => {
	it("R3: is its last bytes, from a whole character on", () => {
		expect(lastBytes("abcdef", 10)).toBe("abcdef");
		expect(lastBytes("abcdef", 3)).toBe("def");
		// "é" is two bytes: a cut that falls inside one starts at the next.
		expect(lastBytes("ééé", 3)).toBe("é");
		expect(lastBytes("ééé", 4)).toBe("éé");
	});
});
