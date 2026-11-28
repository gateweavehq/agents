/**
 * The repository in a conversation's sandbox. An agent can choose a repository the workspace's
 * GitHub App reaches; its sandbox clones it on the conversation's first tool call, onto a branch of
 * the conversation's own (`RunnerSandbox.checkout` in `./sandbox.ts`), and the agent is told where
 * it is.
 */
import {
	PULL_REQUEST_TOOL,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import type { SandboxPort } from "./sandbox-tools";

/** How a checkout went: done now, there already, or why not, in words the model reads. */
export type CheckoutResult =
	| { checkedOut: boolean }
	/** `gone`: a review's head is no longer on GitHub, so there is nothing to check out. */
	| { error: string; gone?: true };

/** A sandbox that can check out a repository. */
export interface CheckoutPort extends SandboxPort {
	checkout(
		repository: SandboxRepository,
		branch: string,
		review?: { number: number; head: string },
	): Promise<CheckoutResult>;
}

/** The sandbox as the tools reach it, with the repository checked out before any of them runs. */
export interface CheckedOutSandbox extends SandboxPort {
	/** Checks the repository out, unless it is already; why it could not be, if it could not. */
	ready(): Promise<string | null>;
}

/**
 * The sandbox as the tools reach it, checking out the repository before the first of them runs.
 * A checkout that fails is the tool's answer, and the next tool call tries again. `onWait` says
 * when a checkout starts and settles, so a turn can show the wait; a failed checkout's
 * retry says it again.
 */
export function withCheckout(
	sandbox: CheckoutPort,
	repository: SandboxRepository,
	branch: string,
	onWait?: (waiting: boolean) => void,
	onSettled?: () => Promise<void>,
): CheckedOutSandbox {
	let pending: Promise<string | null> | undefined;
	const problem = (): Promise<string | null> => {
		if (pending === undefined) {
			onWait?.(true);
			pending = sandbox
				.checkout(repository, branch)
				.then(
					(result) => ("error" in result ? result.error : null),
					() => `${repository.owner}/${repository.name} could not be checked out. Try again.`,
				)
				.finally(() => onWait?.(false));
		}
		return pending.then((found) => {
			if (found !== null) pending = undefined;
			return found;
		});
	};
	/** After a checkout that worked and before the tool's own command, for what the turn notes. */
	const settled = async (): Promise<string | null> => {
		const failed = await problem();
		if (failed === null) await onSettled?.();
		return failed;
	};
	return {
		ready: problem,
		async run(command, cwd, timeoutSeconds, captureOutput, outputMode) {
			const failed = await settled();
			if (failed !== null) return { exitCode: 1, output: failed, timedOut: false };
			return sandbox.run(command, cwd, timeoutSeconds, captureOutput, outputMode);
		},
		async readFile(path) {
			const failed = await settled();
			return failed !== null ? { error: failed } : sandbox.readFile(path);
		},
		async writeFile(path, content) {
			const failed = await settled();
			return failed !== null ? { error: failed } : sandbox.writeFile(path, content);
		},
	};
}

/** What the model is told of the repository, after the agent's instructions. */
export function repositoryNote(repository: SandboxRepository, branch: string): string {
	const name = `${repository.owner}/${repository.name}`;
	return [
		`Your sandbox has the repository ${name} at ${SANDBOX_REPOSITORY_PATH}, on the branch ${branch}, made from ${repository.defaultBranch}.`,
		"Read its AGENTS.md or CLAUDE.md, if it has one, before you change it. Its files are checked out when you first use a tool.",
		`When the work is done and checked, ${PULL_REQUEST_TOOL} proposes it as a pull request; git push does not work in the sandbox.`,
	].join(" ");
}
