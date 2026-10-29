/**
 * Sandboxes: a Linux machine for each conversation with an agent run by Gateweave, where its turns
 * run commands and read and write files. A deployment offers them when it has the container
 * binding; these are the pure parts the registry, the runtime and the app share.
 */

/** What a deployment has when it offers sandboxes: the binding of their Durable Objects. */
export interface SandboxSettings {
	SANDBOX?: unknown;
}

/** Minutes without a request after which a sandbox stops, and its files go with it. */
export const SANDBOX_IDLE_MINUTES = 15;

/**
 * Most sandboxes one workspace's conversations have at once. A sandbox counts from its first turn
 * until `SANDBOX_IDLE_MINUTES` after its last; the deployment's account pays for each.
 */
export const MAX_WORKSPACE_SANDBOXES = 3;

/** Why an agent with a sandbox cannot answer on a server that runs none. */
export const SANDBOX_NOT_OFFERED = "This server does not run sandboxes";

/** Whether the deployment offers sandboxes. */
export function sandboxOffered(settings: SandboxSettings): boolean {
	return settings.SANDBOX !== undefined;
}

/** Where a sandbox checks out its agent's repository. */
export const SANDBOX_REPOSITORY_PATH = "/workspace/repo";

/**
 * The repository a turn's sandbox checks out, as the registry hands it to the runtime. It only
 * names the repository: the Worker mints a token for each of the sandbox's requests to GitHub, so
 * none travels with a turn or enters the sandbox.
 */
export interface SandboxRepository {
	owner: string;
	name: string;
	/** GitHub's id for the repository, which a token is scoped to. */
	externalId: string;
	/** The GitHub App installation that reaches it. */
	installationId: string;
	defaultBranch: string;
}

/** The branch a conversation's sandbox works on, made from the repository's default branch. */
export function conversationBranch(conversationId: string): string {
	return `gateweave/${conversationId}`;
}

/**
 * The tool of a turn whose sandbox has a repository that pushes the conversation's branch and
 * opens a pull request from it. The chat shows its calls by the pull request they made.
 */
export const PULL_REQUEST_TOOL = "open_pull_request";

/** What `PULL_REQUEST_TOOL` answers with when it made or updated the pull request. */
export interface PullRequestOutcome {
	/** `owner/name`. */
	repository: string;
	number: number;
	url: string;
	/** Whether this call opened it, or pushed to one the conversation had open. */
	opened: boolean;
	/** The commit the branch is at now. */
	head: string;
}
