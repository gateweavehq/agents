import { describe, expect, it } from "vitest";
import {
	type CheckoutCommand,
	changedSince,
	commitWork,
	type Git,
	isCommitId,
	pushArguments,
} from "../src/git-work";
import type { CommandResult } from "../src/sandbox-tools";

const AUTHOR = { name: "Builder", email: "noreply@gateweave.com" };
const HEAD = "a1b2c3d4".repeat(5);

/** A git that records what it was asked and answers by the command's first word. */
function recordingGit(answers: Record<string, Partial<CommandResult>> = {}) {
	const asked: { args: string[]; seconds?: number; env?: Record<string, string> }[] = [];
	const defaults: Record<string, Partial<CommandResult>> = {
		// Something is staged, the work is one commit ahead, and HEAD is a commit.
		diff: { exitCode: 1 },
		"merge-base": { output: HEAD },
		"rev-list": { output: "1\n" },
		"rev-parse": { output: `${HEAD}\n` },
	};
	const git: Git = async (args, seconds, env) => {
		asked.push({ args, seconds, env });
		if (args[0] === "bash") {
			return { exitCode: 0, output: `${HEAD}\n`, timedOut: false };
		}
		const answer = answers[args[0] ?? ""] ?? defaults[args[0] ?? ""] ?? {};
		return { exitCode: 0, output: "", timedOut: false, ...answer };
	};
	const run: CheckoutCommand = (args, seconds, env) =>
		git(args[0] === "git" ? args.slice(1) : args, seconds, env);
	return { git, run, asked, commands: () => asked.map(({ args }) => args.join(" ")) };
}

describe("a checkout after the repository's checks", () => {
	it("R2: is the commit when HEAD is and git has nothing to report, files it ignores aside", async () => {
		const { git, commands } = recordingGit();
		expect(await changedSince(git, HEAD)).toBeNull();
		// Untracked files count, one by one; ignored ones are left out by git itself.
		expect(commands()).toEqual([
			"rev-parse HEAD",
			"status --porcelain --untracked-files=all --ignore-submodules=none",
		]);
	});

	it("R2: is not the commit when a file changed or appeared, and says which, twenty at most", async () => {
		const some = recordingGit({ status: { output: " M src/cart.ts\n?? notes.txt\n" } });
		expect(await changedSince(some.git, HEAD)).toEqual({
			changed: " M src/cart.ts\n?? notes.txt",
		});
		const lines = Array.from({ length: 25 }, (_, index) => `?? file-${index}.txt`);
		const many = recordingGit({ status: { output: `${lines.join("\n")}\n` } });
		expect(await changedSince(many.git, HEAD)).toEqual({
			changed: [...lines.slice(0, 20), "and 5 more"].join("\n"),
		});
	});

	it("R2: is not the commit when a new one was made meanwhile", async () => {
		const moved = recordingGit({ "rev-parse": { output: `${"f".repeat(40)}\n` } });
		expect(await changedSince(moved.git, HEAD)).toEqual({
			changed: "A new commit was made while the checks ran.",
		});
		expect(moved.commands()).toEqual(["rev-parse HEAD"]);
	});

	it("R2: is neither the commit nor changed when git cannot say, and what git printed is not passed on", async () => {
		const lost = recordingGit({
			"rev-parse": { exitCode: 128, output: "fatal: not a git repository" },
		});
		expect(await changedSince(lost.git, HEAD)).toEqual({
			unverified: "The checkout's commit could not be read.",
		});
		const unread = recordingGit({ status: { exitCode: 128, output: "fatal: index file corrupt" } });
		expect(await changedSince(unread.git, HEAD)).toEqual({
			unverified: "The checkout's changes could not be read.",
		});
	});
});

describe("a sandbox's work in git", () => {
	it("R2: is committed whole, by its author, and not pushed: the push is a step of its own", async () => {
		const { run, asked, commands } = recordingGit();
		expect(await commitWork(run, "main", "Fix the cart", AUTHOR, "model-1")).toEqual({
			head: HEAD,
		});
		expect(commands()).toEqual([
			"add --all",
			"diff --cached --quiet",
			"commit --quiet --message Fix the cart",
			"fetch --quiet origin +refs/heads/main:refs/remotes/origin/main",
			"rev-parse HEAD",
			`rev-list --count origin/main..${HEAD}`,
			`merge-base origin/main ${HEAD}`,
			expect.stringMatching(/^bash -c /),
		]);
		expect(asked[2]?.env).toEqual({
			GIT_AUTHOR_NAME: "Builder",
			GIT_AUTHOR_EMAIL: "noreply@gateweave.com",
			GIT_COMMITTER_NAME: "Builder",
			GIT_COMMITTER_EMAIL: "noreply@gateweave.com",
		});
	});

	it("R2: makes no commit when nothing is staged, and still says which commit the work is at", async () => {
		const { run, commands } = recordingGit({ diff: { exitCode: 0 } });
		expect(await commitWork(run, "main", "Fix the cart", AUTHOR, "model-1")).toEqual({
			head: HEAD,
		});
		expect(commands()).not.toContain("commit --quiet --message Fix the cart");
	});

	it("R2: has nothing to propose without a commit the default branch lacks, or a commit it can name", async () => {
		const none = recordingGit({ "rev-list": { output: "0\n" } });
		expect(await commitWork(none.run, "main", "T", AUTHOR, "model-1")).toEqual({
			error: "There is nothing to propose: the work has no commit that main does not.",
		});
		const hooks = recordingGit({ commit: { exitCode: 1, output: "lint failed" } });
		expect(await commitWork(hooks.run, "main", "T", AUTHOR, "model-1")).toEqual({
			error: "The changes could not be committed.\nlint failed",
		});
		// What is pushed later is named by this id, so anything else is no answer.
		const odd = recordingGit({ "rev-parse": { output: "HEAD\n" } });
		expect(await commitWork(odd.run, "main", "T", AUTHOR, "model-1")).toEqual({
			error: "The work's commit could not be read.",
		});
	});

	it("R2: is pushed as the commit that was checked, by its id, never as whatever HEAD is by then", () => {
		expect(pushArguments("gateweave/conversation-1", HEAD)).toEqual([
			"push",
			"--porcelain",
			"origin",
			`${HEAD}:refs/heads/gateweave/conversation-1`,
		]);
		expect(pushArguments("b", HEAD).join(" ")).not.toContain("HEAD");
		expect(isCommitId(HEAD)).toBe(true);
		expect(isCommitId("f".repeat(64))).toBe(true);
		for (const not of ["HEAD", "", "main", HEAD.slice(1), `${HEAD}\n`, `${HEAD}:refs/heads/main`]) {
			expect(isCommitId(not), not).toBe(false);
		}
	});
});
