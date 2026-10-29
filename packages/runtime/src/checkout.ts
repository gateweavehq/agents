/**
 * The repository in a conversation's sandbox. An agent can choose a repository the workspace's
 * GitHub App reaches; its sandbox clones it on the conversation's first tool call, onto a branch of
 * the conversation's own (`RunnerSandbox.checkout` in `./sandbox.ts`), and the agent is told where
 * it is.
 */
import { SANDBOX_REPOSITORY_PATH, type SandboxRepository } from "@gateweave/agents-model";
import type { SandboxPort } from "./sandbox-tools";

/** How a checkout went: done now, there already, or why not, in words the model reads. */
export type CheckoutResult = { checkedOut: boolean } | { error: string };

/** A sandbox that can check out a repository. */
export interface CheckoutPort extends SandboxPort {
	checkout(repository: SandboxRepository, branch: string): Promise<CheckoutResult>;
}

/**
 * The sandbox as the tools reach it, checking out the repository before the first of them runs.
 * A checkout that fails is the tool's answer, and the next tool call tries again.
 */
export function withCheckout(
	sandbox: CheckoutPort,
	repository: SandboxRepository,
	branch: string,
): SandboxPort {
	let pending: Promise<string | null> | undefined;
	const problem = async (): Promise<string | null> => {
		pending ??= sandbox.checkout(repository, branch).then(
			(result) => ("error" in result ? result.error : null),
			() => `${repository.owner}/${repository.name} could not be checked out. Try again.`,
		);
		const found = await pending;
		if (found !== null) pending = undefined;
		return found;
	};
	return {
		async run(command, cwd, timeoutSeconds) {
			const failed = await problem();
			if (failed !== null) return { exitCode: 1, output: failed, timedOut: false };
			return sandbox.run(command, cwd, timeoutSeconds);
		},
		async readFile(path) {
			const failed = await problem();
			return failed !== null ? { error: failed } : sandbox.readFile(path);
		},
		async writeFile(path, content) {
			const failed = await problem();
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
	].join(" ");
}
