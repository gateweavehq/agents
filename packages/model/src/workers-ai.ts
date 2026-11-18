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

/**
 * The text models Cloudflare has removed from Workers AI, or has said it will, with the day (UTC)
 * each stops answering: from then on a request for one fails with HTTP 410 and error 5028. None is
 * offered, priced or suggested anywhere (`apps/web/src/lib/removed-models.test.ts` reads the
 * repository for them), and an agent still
 * set to one says so when it runs (`describeFailure` in the runtime). An agent's model is never
 * changed for it: an owner or admin chose it, and another costs something else.
 *
 * The next removal is a line here.
 *
 * - https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/
 *   (read 2026-11-18; the day was moved from 15 to 20 November)
 */
export const WORKERS_AI_REMOVED: Readonly<Record<string, string>> = {
	"@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": "2026-11-20",
	"@cf/deepseek-ai/deepseek-v4-flash-0731": "2026-11-20",
	"@cf/deepseek-ai/deepseek-v4-pro-0813": "2026-11-20",
	"@cf/google/gemma-2b-it-lora": "2026-11-20",
	"@cf/google/gemma-7b-it-lora": "2026-11-20",
	"@cf/meta-llama/llama-2-7b-chat-hf-lora": "2026-11-20",
	"@cf/meta/llama-3.1-8b-instruct-fp8": "2026-11-20",
	"@cf/meta/llama-3.2-1b-instruct": "2026-11-20",
	"@cf/meta/llama-3.2-3b-instruct": "2026-11-20",
	"@cf/moonshotai/kimi-k2.6": "2026-11-20",
	"@cf/moonshotai/kimi-k2.7-code": "2026-11-20",
	"@cf/nvidia/nemotron-3-120b-a12b": "2026-11-20",
	"@cf/qwen/qwen3-30b-a3b-fp8": "2026-11-20",
	"@cf/qwen/qwq-32b": "2026-11-20",
	"@cf/zai-org/glm-5.2": "2026-11-20",
	"@cf/zai-org/glm-5.3-flash": "2026-11-20",
};

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** Whether Cloudflare has removed a Workers AI model, or has said it will. */
export function workersAiRemoved(model: string): boolean {
	return Object.hasOwn(WORKERS_AI_REMOVED, model);
}

/**
 * What an agent says when Cloudflare answers that its model is gone: what happened and what to
 * do, with the day when the model is one of `WORKERS_AI_REMOVED`.
 */
export function workersAiRemovedMessage(model: string): string {
	const day = Object.hasOwn(WORKERS_AI_REMOVED, model) ? WORKERS_AI_REMOVED[model] : undefined;
	const [year, month, date] = (day ?? "").split("-").map(Number);
	const named = MONTHS[(month ?? 0) - 1];
	// Written out rather than left to the runtime's locale data: "20 November 2026".
	const when = named === undefined ? "" : ` on ${date} ${named} ${year}`;
	return `Cloudflare removed ${model} from Workers AI${when}. Choose another model in the agent's settings.`;
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
