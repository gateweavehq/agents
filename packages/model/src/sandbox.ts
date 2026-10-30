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
	/** Minutes of sandbox time each workspace may use in a day (UTC); no limit when unset or empty. */
	SANDBOX_DAILY_MINUTES?: string;
	/**
	 * US dollars the deployment may spend on sandboxes in a month (UTC), as `SANDBOX_SECOND_PRICE`
	 * prices them; no limit when unset or empty. The deployment's meter adds up its workspaces.
	 */
	SANDBOX_MONTHLY_BUDGET?: string;
	/** The binding of the meter's Durable Object, which a monthly budget needs. */
	SANDBOX_METER?: unknown;
}

/** The machine a sandbox runs on: Cloudflare's `standard-1`, with ½ vCPU, 4 GiB of memory and 8 GB of disk. */
export const SANDBOX_INSTANCE = "standard-1";

/**
 * The most one second of a sandbox costs, in US dollars, at Cloudflare's list prices for its
 * machine: 4 GiB of memory at $0.0000025 a GiB-second, ½ vCPU at $0.000020 a vCPU-second while
 * busy, and 8 GB of disk at $0.00000007 a GB-second. It counts the sandbox as busy all along and
 * takes nothing off for what the Workers Paid plan includes, so budgets err on the safe side.
 */
export const SANDBOX_SECOND_PRICE = 4 * 0.0000025 + 0.5 * 0.00002 + 8 * 0.00000007;

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

/** The deployment's limits on sandbox time; null where it sets none. */
export interface SandboxLimits {
	/** Minutes each workspace may use in a day (UTC). */
	dailyMinutes: number | null;
	/** US dollars the deployment may spend in a month (UTC). */
	monthlyBudget: number | null;
}

/** A setting that is not a number allows nothing, so a mistyped limit never lifts it. */
export function sandboxLimits(settings: SandboxSettings): SandboxLimits {
	return {
		dailyMinutes: limit(settings.SANDBOX_DAILY_MINUTES),
		monthlyBudget: limit(settings.SANDBOX_MONTHLY_BUDGET),
	};
}

function limit(setting: unknown): number | null {
	// Wrangler passes a number in `vars` as a number.
	const text = String(setting ?? "").trim();
	if (text === "") return null;
	const value = Number(text);
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Shares of the monthly budget, in percent, at which whoever runs the deployment hears of it. */
export const SANDBOX_BUDGET_ALERTS = [80, 100] as const;

export type SandboxBudgetShare = (typeof SANDBOX_BUDGET_ALERTS)[number];

/** A share of the month's budget that the deployment's sandboxes have just spent. */
export interface SandboxBudgetPassed {
	share: SandboxBudgetShare;
	/** US dollars spent in the month so far. */
	spent: number;
	budget: number;
	/** The month, such as `2026-10` (UTC). */
	month: string;
}

/** Why an agent with a sandbox cannot answer once its workspace has used the day's minutes. */
export const SANDBOX_DAY_USED = "This workspace has used its sandbox time for today";

/** Why an agent with a sandbox cannot answer once the deployment has spent the month's budget. */
export const SANDBOX_BUDGET_SPENT = "This server has spent its sandbox budget for the month";

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
