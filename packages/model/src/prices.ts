/**
 * What models cost, to estimate what each run spent. Prices are in US dollars per million tokens
 * for the standard tier, as each provider's pricing page listed them. A run is estimated at the
 * prices of the day it ran. A model that is not listed here gets no estimate rather than a guess:
 * the provider's bill is the truth, and AI Gateway's logs carry its own figures.
 *
 * Checked 2026-10-28:
 * - https://platform.claude.com/docs/en/about-claude/pricing (cache writes at the 5-minute rate)
 * - https://developers.openai.com/api/docs/pricing
 * - https://ai.google.dev/gemini-api/docs/pricing (context caching, without storage)
 */
import type { ModelProvider } from "./vocabulary";

/** Dollars per million tokens. */
export interface Rates {
	input: number;
	output: number;
	/** Input read from the provider's cache. */
	cacheRead: number;
	/** Input written to the cache. Providers that do not charge for it bill it as input. */
	cacheWrite?: number;
}

export interface ModelPrice extends Rates {
	/** Higher rates for a whole request whose input is over `above` tokens. */
	long?: Rates & { above: number };
	/** The day these prices start (UTC), for a change the provider announced ahead. */
	since?: string;
}

/** The tokens a single model request used. Cache reads and writes are counted in `input`. */
export interface RequestTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const OPENAI_LONG = 272_000;
const GEMINI_LONG = 200_000;

/** Prices by provider and model id. A model with announced changes lists them, oldest first. */
export const MODEL_PRICES: Record<ModelProvider, Record<string, ModelPrice | ModelPrice[]>> = {
	anthropic: {
		"claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
		"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		"claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		"claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		"claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		"claude-haiku-5-5": {
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
		},
		"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	openai: {
		"gpt-6-astra": {
			input: 10,
			output: 50,
			cacheRead: 1,
			long: { above: OPENAI_LONG, input: 20, output: 75, cacheRead: 2 },
		},
		"gpt-6-sol": {
			input: 2,
			output: 10,
			cacheRead: 0.2,
			long: { above: OPENAI_LONG, input: 4, output: 15, cacheRead: 0.4 },
		},
		"gpt-6-luna": {
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			long: { above: OPENAI_LONG, input: 0.2, output: 0.75, cacheRead: 0.02 },
		},
		"gpt-6.1-sol": {
			input: 2,
			output: 10,
			cacheRead: 0.1,
			long: { above: OPENAI_LONG, input: 4, output: 15, cacheRead: 0.2 },
		},
		"gpt-6.1-terra": {
			input: 1,
			output: 5,
			cacheRead: 0.05,
			long: { above: OPENAI_LONG, input: 2, output: 7.5, cacheRead: 0.1 },
		},
		"gpt-5.6-sol": {
			input: 4,
			output: 20,
			cacheRead: 0.4,
			long: { above: OPENAI_LONG, input: 8, output: 30, cacheRead: 0.8 },
		},
		"gpt-5.6-terra": {
			input: 2,
			output: 12,
			cacheRead: 0.2,
			long: { above: OPENAI_LONG, input: 4, output: 18, cacheRead: 0.4 },
		},
		"gpt-5.6-luna": {
			input: 0.2,
			output: 1.2,
			cacheRead: 0.02,
			long: { above: OPENAI_LONG, input: 0.4, output: 1.8, cacheRead: 0.04 },
		},
		"gpt-5.5": {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			long: { above: OPENAI_LONG, input: 10, output: 45, cacheRead: 1 },
		},
		"gpt-5.4": {
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			long: { above: OPENAI_LONG, input: 5, output: 22.5, cacheRead: 0.5 },
		},
		"gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
		"gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02 },
		"gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
		"gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
		"gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
	},
	google: {
		"gemini-4-argon": [
			{ input: 2, output: 10, cacheRead: 0.1 },
			{ input: 4, output: 20, cacheRead: 0.2, since: "2026-12-01" },
		],
		"gemini-3.8-flash": [
			{ input: 0.75, output: 3.75, cacheRead: 0.075 },
			{ input: 1.5, output: 7.5, cacheRead: 0.15, since: "2027-01-01" },
		],
		"gemini-3.6-flash": [
			{ input: 0.75, output: 3.75, cacheRead: 0.075 },
			{ input: 1.5, output: 7.5, cacheRead: 0.15, since: "2027-01-01" },
		],
		"gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03 },
		"gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025 },
		"gemini-3.1-pro-preview": {
			input: 2,
			output: 12,
			cacheRead: 0.2,
			long: { above: GEMINI_LONG, input: 4, output: 18, cacheRead: 0.4 },
		},
		"gemini-3-flash-preview": { input: 0.5, output: 3, cacheRead: 0.05 },
		"gemini-2.5-pro": {
			input: 1.25,
			output: 10,
			cacheRead: 0.125,
			long: { above: GEMINI_LONG, input: 2.5, output: 15, cacheRead: 0.25 },
		},
		"gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03 },
		"gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01 },
	},
};

/**
 * The prices for a model on a day, or null when it is not listed. A dated snapshot of a listed
 * model (`claude-haiku-4-5-20251001`, `gpt-5-2025-08-07`) has its prices; any other variant
 * does not, since it may cost something else.
 */
export function priceOf(provider: ModelProvider, model: string, at: number): ModelPrice | null {
	const prices = MODEL_PRICES[provider];
	const id = model.replace(/^models\//, "");
	const listed = prices[id] ?? prices[id.replace(/-\d{4}-?\d{2}-?\d{2}$/, "")];
	if (!listed) return null;
	const day = new Date(at).toISOString().slice(0, 10);
	const periods = Array.isArray(listed) ? listed : [listed];
	return periods.findLast((period) => period.since === undefined || period.since <= day) ?? null;
}

/**
 * What one model request cost, in millionths of a dollar, or null when the model has no prices
 * here. A request over a model's long-context threshold pays the higher rates for all of it.
 */
export function requestCost(
	provider: ModelProvider,
	model: string,
	tokens: RequestTokens,
	at: number,
): number | null {
	const price = priceOf(provider, model, at);
	if (!price) return null;
	const rates = price.long && tokens.input > price.long.above ? price.long : price;
	const uncached = Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite);
	// Dollars per million tokens are millionths of a dollar per token.
	return Math.round(
		uncached * rates.input +
			tokens.cacheRead * rates.cacheRead +
			tokens.cacheWrite * (rates.cacheWrite ?? rates.input) +
			tokens.output * rates.output,
	);
}
