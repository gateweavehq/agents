/**
 * What `open_pull_request` records on the run for a review of its work: the head the run left,
 * whether GitHub says the pull request is a draft, and why, in words made of the checks' status
 * and the changed files. The tool stands on a sandbox in memory and a GitHub that answers as
 * a test says.
 */
import { GitHubError, type PullRequest } from "@gateweave/agents-github";
import type { PullRequestOutcome } from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checksDraftReason, editsDraftReason } from "../src/checks";
import type { OracleReview } from "../src/oracles";
import { pullRequestTools } from "../src/pull-requests";
import type { RunRecorder } from "../src/trace";
import { type CommandAnswer, MemorySandbox } from "./fake-sandbox";

afterEach(() => {
	vi.restoreAllMocks();
});

const repository = {
	owner: "acme",
	name: "site",
	externalId: "7",
	installationId: "99",
	defaultBranch: "main",
};
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const OUTPUT = "TOKEN-sk-live-4242 /home/runner/.npmrc leaked in the output";

const red = (output = OUTPUT): CommandAnswer => ({ exitCode: 1, output, timedOut: false });

function setup({
	commands = [],
	review,
	memory,
}: {
	commands?: string[];
	review?: OracleReview;
	memory?: Parameters<typeof pullRequestTools>[0]["memory"];
} = {}) {
	const sandbox = new MemorySandbox();
	const recorded: PullRequestOutcome[] = [];
	const github = {
		/** What the next `propose` calls do, in order: an error is thrown; a pull request answers. */
		answers: [] as (Partial<PullRequest> | Error)[],
		proposed: 0,
	};
	const run = {
		targets: { tainted: false, trusted: new Set() },
		toolStarted: () => "span",
		toolEnded: () => {},
	} as unknown as RunRecorder;
	const tools = pullRequestTools({
		sandbox,
		checks: {
			commands: async () => commands,
			sandbox,
			now: () => sandbox.clock,
		},
		ready: async () => null,
		github: {
			async propose(input) {
				github.proposed += 1;
				const answer = github.answers.shift();
				if (answer instanceof Error) throw answer;
				return {
					number: 12,
					url: "https://github.com/acme/site/pull/12",
					opened: github.proposed === 1,
					title: input.title,
					state: "open",
					head: FIRST,
					headRef: input.branch,
					...answer,
				};
			},
			...(review ? { review: async () => review } : {}),
		},
		repository,
		...(memory ? { memory } : {}),
		branch: "gateweave/conversation-1",
		runId: "run-1",
		agentName: "Builder",
		model: "model-1",
		author: async () => ({ name: "Builder", email: "noreply@gateweave.com" }),
		record: async (outcome) => {
			recorded.push(outcome);
		},
		run,
	});
	const execute = tools.open_pull_request?.execute as unknown as (
		input: object,
		options: { toolCallId: string; messages: [] },
	) => Promise<PullRequestOutcome>;
	const call = (title = "Fix the cart") =>
		execute({ title, body: "It ignored codes." }, { toolCallId: "call", messages: [] });
	return { sandbox, recorded, github, call };
}

describe("the head a run leaves on a pull request it recorded", () => {
	it("is the second push's, though the update of the pull request's words then fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { sandbox, recorded, github, call } = setup();
		sandbox.pushAnswers.push({ head: FIRST, pushed: true }, { head: SECOND, pushed: true });
		await call();
		expect(recorded.map((outcome) => outcome.head)).toEqual([FIRST]);

		// The second push reaches GitHub, and the update of the pull request fails after it.
		github.answers.push(new GitHubError(503, "Service Unavailable"));
		await expect(call("Fix the cart, again")).rejects.toThrow(/is pushed, but/);
		// The run holds the head it left, as the pull request it recorded first.
		expect(recorded.map((outcome) => outcome.head)).toEqual([FIRST, SECOND]);
		expect(recorded[1]).toMatchObject({ number: 12, repository: "acme/site", head: SECOND });
		expect(error).toHaveBeenCalled();
	});

	it("is recorded once when the update fails and the push moved nothing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { sandbox, recorded, github, call } = setup();
		sandbox.pushAnswers.push({ head: FIRST, pushed: true }, { head: FIRST, pushed: false });
		await call();
		github.answers.push(new GitHubError(503, "Service Unavailable"));
		await expect(call()).rejects.toThrow();
		expect(recorded.map((outcome) => outcome.head)).toEqual([FIRST]);
	});

	it("is the second push's, though the lookup of the call's memory fails after the push", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		let failing = false;
		const memory = {
			recall: async () => {
				if (failing) throw new Error("The memory could not be read");
				return null;
			},
			remember: async () => {},
		};
		const { sandbox, recorded, call } = setup({ memory });
		sandbox.pushAnswers.push({ head: FIRST, pushed: true }, { head: SECOND, pushed: true });
		await call();
		expect(recorded.map((outcome) => outcome.head)).toEqual([FIRST]);
		// The push reaches GitHub, and the lookup fails before the pull request is updated.
		failing = true;
		await expect(call("Fix the cart, again")).rejects.toThrow("The memory could not be read");
		expect(recorded.map((outcome) => outcome.head)).toEqual([FIRST, SECOND]);
	});

	it("is not recorded for a pull request the run has not recorded", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { sandbox, recorded, github, call } = setup();
		sandbox.pushAnswers.push({ head: FIRST, pushed: true });
		github.answers.push(new GitHubError(503, "Service Unavailable"));
		await expect(call()).rejects.toThrow();
		expect(recorded).toEqual([]);
	});
});

describe("whether the pull request is a draft", () => {
	it("is GitHub's word, not what the tool meant: an open pull request that stays ready is not a draft", async () => {
		const { sandbox, recorded, github, call } = setup({ commands: ["pnpm test"] });
		// Three failed rounds: the tool asks for a draft, and the existing pull request keeps its state.
		sandbox.answers.push(red(), red(), red());
		github.answers.push({ draft: false });
		await expect(call()).rejects.toThrow();
		await expect(call()).rejects.toThrow();
		const outcome = await call();
		expect(outcome).toMatchObject({ checks: "failed", draft: false });
		expect(outcome).not.toHaveProperty("draftReason");
		expect(recorded.at(-1)).toMatchObject({ draft: false });
	});

	it("is a draft with a reason when GitHub says so", async () => {
		const { sandbox, github, call } = setup({ commands: ["pnpm test"] });
		sandbox.answers.push(red(), red(), red());
		github.answers.push({ draft: true });
		await expect(call()).rejects.toThrow();
		await expect(call()).rejects.toThrow();
		expect(await call()).toMatchObject({
			draft: true,
			draftReason: "The repository's checks did not pass: check 1 of 1 exited with code 1.",
		});
	});
});

describe("the reason a pull request is a draft", () => {
	it("is made of the checks' status and holds no command output, no command and no model note", async () => {
		const { sandbox, recorded, call } = setup({ commands: ["pnpm test --token=sk-live-4242"] });
		sandbox.answers.push(red(), red(), red());
		await expect(call()).rejects.toThrow();
		await expect(call()).rejects.toThrow();
		const outcome = await call();
		// The model reads the end of the output; the record does not.
		expect(outcome.note).toContain(OUTPUT);
		const kept = JSON.stringify(recorded);
		expect(outcome.draftReason).toBe(
			"The repository's checks did not pass: check 1 of 1 exited with code 1.",
		);
		const { note: _, ...stored } = recorded[0] ?? ({} as PullRequestOutcome);
		expect(JSON.stringify(stored)).not.toContain("TOKEN");
		expect(JSON.stringify(stored)).not.toContain("sk-live-4242");
		expect(kept).toContain("exited with code 1");
	});

	it("names the edited files and how they changed, from GitHub's list, and is a draft for them", async () => {
		const { call } = setup({
			review: {
				edits: [
					{ path: "src/cart.test.ts", change: "modified", kind: "test" },
					{ path: "package.json", change: "deleted", kind: "manifest" },
				] as never,
			},
		});
		const outcome = await call();
		expect(outcome).toMatchObject({ draft: true });
		expect(outcome.draftReason).toBe(
			"The work modifies or deletes files that decide whether its checks pass: src/cart.test.ts (modified), package.json (deleted).",
		);
	});

	it("is words for each status, with no check's command or output in any", () => {
		const exited = (exitCode: number) => ({ kind: "exited" as const, exitCode });
		const result = (outcome: never) => ({
			command: "secret-cmd",
			outcome,
			seconds: 1,
			tail: OUTPUT,
		});
		expect(checksDraftReason({ status: "passed", results: [] })).toBeNull();
		expect(checksDraftReason({ status: "not-run", results: [] })).toBe(
			"The repository's checks were not run: the time a run has for them was used up.",
		);
		expect(
			checksDraftReason({
				status: "failed",
				results: [
					result(exited(0) as never),
					result({ kind: "timed-out", limitSeconds: 600 } as never),
				],
			}),
		).toBe("The repository's checks did not pass: check 2 of 2 timed out after 600 seconds.");
		expect(
			checksDraftReason({
				status: "failed",
				results: [result(exited(0) as never)],
				changed: " M src/a.ts",
			}),
		).toBe(
			"A check left the repository's files different from the commit, so the checks did not all run on it.",
		);
		expect(
			checksDraftReason({
				status: "failed",
				results: [result(exited(0) as never)],
				unverified: "x",
			}),
		).toBe(
			"Whether the repository's files were still the commit's after a check could not be told.",
		);
		const edits = Array.from({ length: 7 }, (_, n) => ({
			path: `t${n}.test.ts`,
			change: "modified" as const,
			kind: "test" as const,
		}));
		expect(editsDraftReason({ edits })).toContain("t4.test.ts (modified) and 2 more.");
		expect(editsDraftReason({ edits: [] })).toBeNull();
		expect(editsDraftReason({ unverified: "the branch is not on GitHub" })).toBe(
			"Whether the work edits the files its checks rely on could not be told.",
		);
	});
});
