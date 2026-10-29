/**
 * Pull requests from a conversation's sandbox. `open_pull_request` commits what the agent changed
 * in the repository, pushes the conversation's branch (`RunnerSandbox.push`), and opens a pull
 * request from it against the default branch, or pushes to the one the branch has open.
 *
 * The push leaves through `SandboxOutbound`, which lets that one push through with a token that
 * writes, and only to the conversation's branch. The pull request is made here, in the Worker, with
 * a token for pull requests alone. The sandbox never holds either.
 */
import {
	type GitHubApp,
	GitHubError,
	openPullRequest,
	openPullRequestFrom,
	updatePullRequest,
} from "@gateweave/agents-github";
import {
	PULL_REQUEST_TOOL,
	type PullRequestOutcome,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { failureForLogs } from "./models";
import { SANDBOX_SERVER } from "./sandbox-tools";
import { traced } from "./tools";
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
	push(branch: string, message: string, author: CommitAuthor): Promise<PushResult>;
}

/** The pull request from a branch: the one it has open, updated, or a new one. */
export interface PullRequestPort {
	propose(input: {
		branch: string;
		title: string;
		body: string;
	}): Promise<{ number: number; url: string; opened: boolean }>;
}

/** Pull requests made on GitHub with the workspace's GitHub App. */
export function gitHubPullRequests(app: GitHubApp, repository: SandboxRepository): PullRequestPort {
	const name = { owner: repository.owner, name: repository.name };
	return {
		async propose({ branch, title, body }) {
			const token = await app.repositoryToken(repository.installationId, repository.externalId, {
				pull_requests: "write",
			});
			const open = await openPullRequestFrom(token, name, branch);
			if (open) {
				const updated = await updatePullRequest(token, name, open.number, { title, body });
				return { number: updated.number, url: updated.url, opened: false };
			}
			const head = branch;
			const base = repository.defaultBranch;
			const made = await openPullRequest(token, name, { title, body, head, base });
			return { number: made.number, url: made.url, opened: true };
		},
	};
}

export interface PullRequestToolOptions {
	sandbox: PushPort;
	/** Checks the repository out first, when it is not yet; why it could not be, if it could not. */
	ready: () => Promise<string | null>;
	github: PullRequestPort;
	repository: SandboxRepository;
	branch: string;
	author: CommitAuthor;
	/** Puts the pull request on the run. */
	record: (outcome: PullRequestOutcome) => Promise<void>;
	run: RunRecorder;
}

/** `open_pull_request`, traced in `run` like the sandbox's other tools. */
export function pullRequestTools(options: PullRequestToolOptions): ToolSet {
	const { sandbox, ready, github, repository, branch, author, record, run } = options;
	const name = `${repository.owner}/${repository.name}`;
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
		execute: async ({ title, body }): Promise<PullRequestOutcome> => {
			const problem = await ready();
			if (problem !== null) throw new Error(problem);
			const pushed = await sandbox.push(branch, title, author);
			if ("error" in pushed) throw new Error(pushed.error);
			let made: Awaited<ReturnType<PullRequestPort["propose"]>>;
			try {
				made = await github.propose({ branch, title, body });
			} catch (error) {
				console.error("A pull request was not made", failureForLogs(error));
				throw new Error(describeGitHubFailure(error, name, branch));
			}
			const outcome: PullRequestOutcome = { repository: name, ...made, head: pushed.head };
			await record(outcome);
			return outcome;
		},
	});
	return { [PULL_REQUEST_TOOL]: traced(open, SANDBOX_SERVER, PULL_REQUEST_TOOL, run) };
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
