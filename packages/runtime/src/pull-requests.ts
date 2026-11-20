/**
 * Pull requests from a conversation's sandbox. `open_pull_request` commits what the agent changed
 * in the repository, pushes the conversation's branch (`RunnerSandbox.push`), and opens a pull
 * request from it against the default branch, or pushes to the one the branch has open.
 *
 * When the repository has checks (AGT-142, `./checks.ts`), the tool runs them between the commit
 * and the push. A round that fails pushes and opens nothing, and the model reads what failed; the
 * third failed round of a run pushes the work anyway and opens the pull request as a draft. The
 * body then ends with a section the tool writes, which says what ran. A repository without checks
 * gets none of this: its pull requests are made as before.
 *
 * A call that is retried or replayed (AGT-147) finds what the first one proposed in the
 * conversation's memory and returns it, so the checks do not run twice and a pull request the
 * branch's open one cannot stand in for is not made again.
 *
 * The push leaves through `SandboxOutbound`, which lets that one push through with a token that
 * writes, and only to the conversation's branch. The pull request is made here, in the Worker, with
 * a token that writes pull requests and only reads the code. The sandbox never holds either.
 */
import {
	type GitHubApp,
	GitHubError,
	openPullRequest,
	openPullRequestFrom,
	type PullRequest,
	updatePullRequest,
} from "@gateweave/agents-github";
import {
	CHECK_LIMITS,
	PULL_REQUEST_TOOL,
	type PullRequestOutcome,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type CheckRound,
	type CheckRunner,
	type ChecksSpent,
	checkPassed,
	checksNotRunSection,
	checksSection,
	describeDraft,
	describeFailedRound,
	describeOutcome,
	NO_SANDBOX,
	pullRequestBody,
	runChecks,
} from "./checks";
import { failureForLogs } from "./models";
import { SANDBOX_SERVER } from "./sandbox-tools";
import { type SummarizedFailure, traced } from "./tools";
import type { RunRecorder } from "./trace";

/** Who a sandbox's commits are by: the agent, at an address that takes no mail. */
export interface CommitAuthor {
	name: string;
	email: string;
}

export const COMMIT_EMAIL = "noreply@gateweave.com";

/**
 * How a push went: the commit the branch is at, and whether this push moved it there; or why there
 * was none, in words the model reads.
 */
export type PushResult = { head: string; pushed: boolean } | { error: string };

/** A sandbox that pushes the conversation's branch. `RunnerSandbox` is the real one. */
export interface PushPort {
	push(branch: string, message: string, author: CommitAuthor, model: string): Promise<PushResult>;
}

/** How a commit went: the commit the checkout is at, or why there is none to propose. */
export type CommitResult = { head: string } | { error: string };

/**
 * A sandbox that takes a push in two steps, with the repository's checks between them
 * (`./checks.ts`): the commit first, then that commit's push and no other's.
 */
export interface CheckPort extends CheckRunner {
	/** Commits every change, unless there is none, and says which commit the work is at. */
	commit(message: string, author: CommitAuthor, model: string): Promise<CommitResult>;
	/**
	 * Pushes `head` to `branch` and commits nothing: what a check, or anything else on the machine,
	 * changed since the commit stays out of the push.
	 */
	pushCommit(branch: string, head: string): Promise<PushResult>;
}

/** The pull request from a branch: the one it has open, updated, or a new one. */
export interface PullRequestPort {
	propose(input: {
		branch: string;
		title: string;
		body: string;
		/** Opens a new pull request as a draft. One that is open already stays as it is. */
		draft?: boolean;
	}): Promise<PullRequest & { opened: boolean }>;
}

/** Pull requests made on GitHub with the workspace's GitHub App. */
export function gitHubPullRequests(app: GitHubApp, repository: SandboxRepository): PullRequestPort {
	const name = { owner: repository.owner, name: repository.name };
	return {
		async propose({ branch, title, body, draft = false }) {
			// GitHub lists only Pull requests for these calls, but refuses to open one with "not all
			// refs are readable" unless the token can also read the branches.
			const token = await app.repositoryToken(repository.installationId, repository.externalId, {
				contents: "read",
				pull_requests: "write",
			});
			const open = await openPullRequestFrom(token, name, branch);
			if (open) {
				const updated = await updatePullRequest(token, name, open.number, { title, body });
				return { ...updated, opened: false };
			}
			const head = branch;
			const base = repository.defaultBranch;
			const made = await openPullRequest(token, name, {
				title,
				body,
				head,
				base,
				...(draft ? { draft: true } : {}),
			});
			return { ...made, opened: true };
		},
	};
}

/** The repository's checks, as `open_pull_request` reaches them. */
export interface ChecksOptions {
	/**
	 * The commands as the repository's settings hold them now. Asked at each call, and of the
	 * registry alone: never of the sandbox, the turn or the model.
	 */
	commands: () => Promise<string[]>;
	/** Where they run. Null in a turn that works on files without a sandbox, which runs none. */
	sandbox: CheckPort | null;
	/** The clock that times them; the tests'. */
	now?: () => number;
}

export interface PullRequestToolOptions {
	sandbox: PushPort;
	/** Left out, the tool is as it was before repositories had checks. */
	checks?: ChecksOptions;
	/** Checks the repository out first, when it is not yet; why it could not be, if it could not. */
	ready: () => Promise<string | null>;
	github: PullRequestPort;
	repository: SandboxRepository;
	branch: string;
	/** The run these tools serve: part of the memory's key, so a later run proposes afresh. */
	runId: string;
	agentName: string;
	model: string;
	/**
	 * Who the commit is by. Gateweave's own loop asks only when a push happens, since it may take a
	 * lookup; an engine turn knows it already, as the engine commits under the same identity.
	 */
	author: () => Promise<CommitAuthor>;
	/** Puts the pull request on the run. */
	record: (outcome: PullRequestOutcome) => Promise<void>;
	run: RunRecorder;
	/** Left out, every call proposes as if it were the first. */
	memory?: PullRequestMemory;
}

/** A remembered proposal: the words it was made with, and what it came to. */
export interface PullRequestMemoryEntry {
	title: string;
	body: string;
	outcome: PullRequestOutcome;
}

/**
 * What a conversation's `open_pull_request` calls proposed, kept past the turn so a retried or
 * replayed call returns the first outcome instead of repeating the work (AGT-147).
 */
export interface PullRequestMemory {
	/** The proposal the latest call under this key recorded, if there was one. */
	recall(key: string): Promise<PullRequestMemoryEntry | null>;
	/** Records a call's proposal under its key. Only a call that proposed writes. */
	remember(key: string, entry: PullRequestMemoryEntry): Promise<void>;
}

/** `open_pull_request`, traced in `run` like the sandbox's other tools. */
export function pullRequestTools(options: PullRequestToolOptions): ToolSet {
	const {
		sandbox,
		checks,
		ready,
		github,
		repository,
		branch,
		runId,
		agentName,
		model,
		author,
		record,
		run,
		memory,
	} = options;
	const name = `${repository.owner}/${repository.name}`;
	// The tools are made once for a turn, which is one run: what its calls spent adds up here.
	const spent: ChecksSpent = { failedRounds: 0, seconds: 0 };
	// One call at a time. A model can make two at once, which would commit, check and push over
	// each other in the one checkout, and each count the run's time for checks from the same start.
	let last: Promise<unknown> = Promise.resolve();
	const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
		const mine = last.then(work, work);
		last = mine.catch(() => {});
		return mine;
	};
	/**
	 * Commits, runs the checks on the commit, and pushes it. A round that fails throws before the
	 * push, until the run's last allowed failure, which pushes the work for a draft. The commit is
	 * the caller's: the memory is consulted between the two, so a retried call skips the checks.
	 */
	const checkAndPush = async (
		commands: string[],
		machine: CheckPort,
		committed: { head: string },
		signal: AbortSignal | undefined,
	): Promise<{ pushed: PushResult; round: CheckRound; head: string }> => {
		const round = await runChecks(commands, machine, committed.head, run, spent, {
			now: checks?.now,
			signal,
		});
		// Checks take minutes, and a turn stopped meanwhile proposes nothing once they end.
		signal?.throwIfAborted();
		if (round.status === "failed") {
			spent.failedRounds += 1;
			if (spent.failedRounds < CHECK_LIMITS.failedRounds) {
				throw new ChecksFailed(describeFailedRound(round, spent), round);
			}
		}
		return {
			pushed: await machine.pushCommit(branch, committed.head),
			round,
			head: committed.head,
		};
	};
	/**
	 * The memory's key for one head: the run and the branch it is on. The words stay out of it, in
	 * the entry: a later call at the same head with other words supersedes what an earlier one
	 * proposed, and only a call with the entry's own words replays it.
	 */
	const memoKey = (head: string): string => `gateweave:pull-request:${runId}:${branch}:${head}`;
	const recall = async (
		head: string,
		title: string,
		body: string,
	): Promise<PullRequestOutcome | null> => {
		if (memory === undefined) return null;
		const entry = await memory.recall(memoKey(head));
		return entry !== null && entry.title === title && entry.body === body ? entry.outcome : null;
	};
	const remember = async (
		head: string,
		title: string,
		body: string,
		outcome: PullRequestOutcome,
	): Promise<void> => {
		if (memory !== undefined) await memory.remember(memoKey(head), { title, body, outcome });
	};
	const open = tool({
		description: `Proposes your work on ${name} as a pull request against ${repository.defaultBranch}. It commits every change in ${SANDBOX_REPOSITORY_PATH} (git add --all) with the title as the message, pushes the branch ${branch}, and opens a pull request from it; called again, it pushes the new work and updates that pull request. To split the work into several commits, commit with git first. Run the project's checks before you call it. git push does not work in the sandbox: this is the only way to push.`,
		inputSchema: z.object({
			title: z
				.string()
				.trim()
				.min(1)
				.max(250)
				.describe("The pull request's title, and the commit message if it commits"),
			body: z
				.string()
				.max(60_000)
				.describe("What changed and why, and how it was checked, in Markdown"),
		}),
		execute: ({ title, body }, { abortSignal }) =>
			inTurn(() => {
				// A call that waited its turn while the turn was stopped does not begin.
				abortSignal?.throwIfAborted();
				return propose(title, body, abortSignal);
			}),
	});
	const propose = async (
		title: string,
		body: string,
		abortSignal: AbortSignal | undefined,
	): Promise<PullRequestOutcome> => {
		const problem = await ready();
		if (problem !== null) throw new Error(problem);
		const commands = checks ? await currentChecks(checks) : [];
		let pushed: PushResult;
		// What the tool adds to the body and to its answer; nothing when no checks are set.
		let section: string | null = null;
		let about: Pick<PullRequestOutcome, "checks" | "draft" | "note"> = {};
		if (commands.length === 0) {
			pushed = await sandbox.push(branch, title, await author(), model);
			// A retry's push is a no-op: the commit is there, so only the proposal is skipped.
			const hit = "error" in pushed ? null : await recall(pushed.head, title, body);
			if (hit !== null) {
				// Recorded again: the first call's record may have failed, and this sets the same
				// pull request on the run, so recording twice changes nothing.
				await record(hit);
				return hit;
			}
		} else if (!checks?.sandbox) {
			pushed = await sandbox.push(branch, title, await author(), model);
			const hit = "error" in pushed ? null : await recall(pushed.head, title, body);
			if (hit !== null) {
				await record(hit);
				return hit;
			}
			section = checksNotRunSection(NO_SANDBOX);
			about = { checks: "not run", draft: false };
		} else {
			const machine = checks.sandbox;
			const committed = await machine.commit(title, await author(), model);
			if ("error" in committed) throw new Error(committed.error);
			const hit = await recall(committed.head, title, body);
			if (hit !== null) {
				await record(hit);
				return hit;
			}
			const checked = await checkAndPush(commands, machine, committed, abortSignal);
			pushed = checked.pushed;
			const { status } = checked.round;
			const draft = status !== "passed";
			section = checksSection(checked.round, checked.head, draft);
			about = {
				checks: status === "not-run" ? "not run" : status,
				draft,
				...(draft ? { note: describeDraft(checked.round) } : {}),
			};
		}
		if ("error" in pushed) throw new Error(pushed.error);
		// The model's own copy of the section goes whether checks are set or not: the heading is
		// the tool's, and a reader takes what stands under it as the tool's word.
		const written = pullRequestBody(body, section, agentName);
		let made: Awaited<ReturnType<PullRequestPort["propose"]>>;
		try {
			made = await github.propose({
				branch,
				title,
				body: written,
				...(about.draft ? { draft: true } : {}),
			});
		} catch (error) {
			console.error("A pull request was not made", failureForLogs(error));
			throw new Error(describeGitHubFailure(error, name, branch));
		}
		const outcome: PullRequestOutcome = {
			repository: name,
			number: made.number,
			url: made.url,
			opened: made.opened,
			title: made.title,
			branch: made.headRef,
			state: made.state,
			additions: made.additions,
			deletions: made.deletions,
			changedFiles: made.changedFiles,
			head: pushed.head,
			...about,
		};
		await record(outcome);
		// Only a call that proposed is remembered: a failed one is retried as if it were the first.
		await remember(pushed.head, title, body, outcome);
		return outcome;
	};
	return {
		[PULL_REQUEST_TOOL]: traced(open, SANDBOX_SERVER, PULL_REQUEST_TOOL, run, {
			showErrors: true,
			contentFields: ["title", "body"],
		}),
	};
}

/**
 * A round of checks that did not pass, and so opened nothing. Its message is the model's: it has
 * the end of the failed command's output. The trace gets `summary`, which has none of it.
 */
export class ChecksFailed extends Error implements SummarizedFailure {
	readonly summary: string;

	constructor(message: string, round: CheckRound) {
		super(message);
		this.name = "ChecksFailed";
		const failed = round.results.find((result) => !checkPassed(result));
		// No file's name and no reason in git's words: those are for the model.
		const why =
			round.changed !== undefined
				? ". A check changed the repository's files, so they would not all have run on the commit"
				: round.unverified !== undefined
					? ". Whether they ran on the commit could not be told"
					: failed
						? `. Check ${round.results.indexOf(failed) + 1}: ${describeOutcome(failed.outcome)}`
						: "";
		this.summary = `The repository's checks did not pass, so nothing was pushed${why}`;
	}
}

/**
 * The repository's checks as they are set now. When the registry cannot say, the tool opens
 * nothing: a pull request that skipped its checks because a read failed would look like one
 * whose repository has none.
 */
async function currentChecks(checks: ChecksOptions): Promise<string[]> {
	try {
		return await checks.commands();
	} catch (error) {
		console.error("A repository's checks were not read", failureForLogs(error));
		throw new Error(
			"The repository's checks could not be read, so nothing was pushed and no pull request was opened. Try again.",
		);
	}
}

/** Why GitHub made no pull request, in words the model reads; the work is pushed either way. */
function describeGitHubFailure(error: unknown, name: string, branch: string): string {
	const pushed = `${branch} is pushed, but`;
	if (!(error instanceof GitHubError)) {
		return `${pushed} GitHub could not be reached to open the pull request. Try again.`;
	}
	switch (error.status) {
		case 401:
		case 403:
			return `${pushed} the workspace's GitHub App may not open pull requests on ${name}. An owner or admin can give it the Pull requests permission.`;
		case 404:
			return `${pushed} the workspace's GitHub App no longer reaches ${name}.`;
		case 422:
			return `${pushed} GitHub refused the pull request: ${error.message}`;
		default:
			return `${pushed} GitHub did not open the pull request (it answered ${error.status}). Try again.`;
	}
}
