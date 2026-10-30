/**
 * Sandboxes: a Linux machine for each conversation with an agent run by Gateweave, where its turns
 * run commands and read and write files. A deployment offers them when it has the container
 * binding; these are the pure parts the registry, the runtime and the app share.
 */

/**
 * What a deployment has when it offers sandboxes: the binding of their Durable Objects, and the
 * workspaces it offers them to.
 */
export interface SandboxSettings {
	SANDBOX?: unknown;
	/**
	 * The ids of the workspaces that may use sandboxes, separated by commas or spaces; every
	 * workspace when unset or empty. Gateweave Cloud offers them by invitation.
	 */
	SANDBOX_WORKSPACES?: string;
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

/** Why an agent with a sandbox cannot answer in a workspace the server has not invited. */
export const SANDBOX_NOT_INVITED = "This server runs sandboxes only for the workspaces it invites";

/** Whether the deployment offers sandboxes. */
export function sandboxOffered(settings: SandboxSettings): boolean {
	return settings.SANDBOX !== undefined;
}

/**
 * How the deployment offers sandboxes to a workspace: to it, only to the workspaces it invites
 * (not this one), or to none.
 */
export type SandboxOffer = "offered" | "by-invitation" | "none";

export function sandboxOfferTo(settings: SandboxSettings, workspaceId: string): SandboxOffer {
	if (!sandboxOffered(settings)) return "none";
	const invited = (settings.SANDBOX_WORKSPACES ?? "").split(/[\s,]+/).filter(Boolean);
	return invited.length === 0 || invited.includes(workspaceId) ? "offered" : "by-invitation";
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
