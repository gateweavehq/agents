/**
 * Workers AI, the one provider that needs no key of a workspace's own: the deployment pays for it
 * through its Cloudflare account, and offers it only when its operator sets a token for it. These
 * are the pure parts the registry, the runtime and the app share; the token itself is never
 * stored or returned by any of them.
 */

/** What a deployment sets to offer Workers AI, and to reach AI Gateway. */
export interface WorkersAiSettings {
	/** A Cloudflare API token with Workers AI permission. A secret, never in `wrangler.jsonc`. */
	WORKERS_AI_TOKEN?: string;
	/** The account that pays. Taken from `AI_GATEWAY_URL` when unset. */
	CLOUDFLARE_ACCOUNT_ID?: string;
	/** `https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>`. */
	AI_GATEWAY_URL?: string;
	/**
	 * The ids of the workspaces that may use Workers AI, separated by commas or spaces; every
	 * workspace when unset. `sandbox` invites the workspaces `SANDBOX_WORKSPACES` invites.
	 */
	WORKERS_AI_WORKSPACES?: string;
	/** US dollars each workspace may spend on Workers AI in a day (UTC). No limit when unset. */
	WORKERS_AI_DAILY_DOLLARS?: string;
	SANDBOX_WORKSPACES?: string;
}

/** Whether the deployment offers Workers AI to a workspace: to all, by invitation, or not at all. */
export type WorkersAiOffer = "offered" | "by-invitation" | "none";

/** Why a workspace the deployment did not invite cannot use Workers AI. */
export const WORKERS_AI_NOT_INVITED =
	"This server offers Workers AI only to the workspaces it invites";

/** Why a workspace that spent its Workers AI for the day cannot use more until the day ends. */
export const WORKERS_AI_DAY_USED = "This workspace has used its Workers AI for today";

export function workersAiOfferTo(settings: WorkersAiSettings, workspaceId: string): WorkersAiOffer {
	if (!workersAiOffered(settings)) return "none";
	const named = (settings.WORKERS_AI_WORKSPACES ?? "").trim();
	const list = named === "sandbox" ? (settings.SANDBOX_WORKSPACES ?? "") : named;
	const invited = list.split(/[\s,]+/).filter(Boolean);
	// `sandbox` with no sandbox invitations invites nobody, rather than everyone.
	if (named === "sandbox" && invited.length === 0) return "by-invitation";
	return invited.length === 0 || invited.includes(workspaceId) ? "offered" : "by-invitation";
}

/**
 * Each workspace's daily Workers AI spend, in US dollars, at Workers AI's prices; null when there
 * is no limit. A setting that is not a number allows nothing, so a mistyped limit never lifts it.
 */
export function workersAiDailyLimit(settings: WorkersAiSettings): number | null {
	// Wrangler passes a number in `vars` as a number.
	const text = String(settings.WORKERS_AI_DAILY_DOLLARS ?? "").trim();
	if (text === "") return null;
	const value = Number(text);
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Why an agent that uses Workers AI cannot answer on a server that did not turn it on. */
export const WORKERS_AI_NOT_OFFERED = "This server does not offer Workers AI";

const GATEWAY_URL = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([\w-]+)\/([\w-]+)\/*$/;
const ACCOUNT_ID = /^[\w-]+$/;

/** The account and gateway an AI Gateway address names, or null when it is not one. */
export function parseGatewayUrl(url: string): { account: string; gateway: string } | null {
	const found = GATEWAY_URL.exec(url);
	const [, account, gateway] = found ?? [];
	return account !== undefined && gateway !== undefined ? { account, gateway } : null;
}

/** The account that pays for Workers AI: the one named outright, else the gateway's. */
export function workersAiAccount(settings: WorkersAiSettings): string | null {
	const named = settings.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (named) return ACCOUNT_ID.test(named) ? named : null;
	const gateway = settings.AI_GATEWAY_URL?.trim();
	return gateway ? (parseGatewayUrl(gateway)?.account ?? null) : null;
}

/** Whether the deployment offers Workers AI: it has the token and knows whose account pays. */
export function workersAiOffered(settings: WorkersAiSettings): boolean {
	return Boolean(settings.WORKERS_AI_TOKEN) && workersAiAccount(settings) !== null;
}

/** Where Cloudflare's OpenAI-compatible Workers AI API sits for an account. */
export function workersAiBaseUrl(account: string): string {
	return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
}
