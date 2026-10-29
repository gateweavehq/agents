import { expect, it } from "vitest";
import { MODEL_PRICES, priceOf, requestCost } from "../src";

const day = (date: string) => Date.parse(`${date}T12:00:00Z`);
const NOW = day("2026-10-28");
const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});

it("prices a request in millionths of a dollar", () => {
	// A million tokens in and out of Sonnet 5.5: $2 and $10.
	expect(requestCost("anthropic", "claude-sonnet-5-5", tokens(1_000_000, 1_000_000), NOW)).toBe(
		12_000_000,
	);
	expect(requestCost("openai", "gpt-5-mini", tokens(2_000, 500), NOW)).toBe(1_500);
});

it("prices cached input at the cache's rates", () => {
	// 1,000 input tokens, of which 600 were read from the cache and 200 written to it.
	const cost = requestCost("anthropic", "claude-opus-5-5", tokens(1_000, 0, 600, 200), NOW);
	expect(cost).toBe(200 * 4 + 600 * 0.2 + 200 * 5);
	// Providers that do not charge for writing to the cache bill it as input.
	expect(requestCost("openai", "gpt-5.5", tokens(1_000, 0, 0, 400), NOW)).toBe(1_000 * 5);
});

it("charges a long request the long-context rates for all of it", () => {
	expect(requestCost("anthropic", "claude-haiku-5-5", tokens(100_000, 1_000), NOW)).toBe(
		100_000 * 0.1 + 1_000 * 0.5,
	);
	expect(requestCost("anthropic", "claude-haiku-5-5", tokens(100_001, 1_000), NOW)).toBe(
		Math.round(100_001 * 0.5 + 1_000 * 2.5),
	);
	expect(requestCost("google", "gemini-2.5-pro", tokens(300_000, 0), NOW)).toBe(300_000 * 2.5);
});

it("charges tokens summed over several requests the standard rates, whatever their total", () => {
	expect(requestCost("openai", "gpt-5.5", tokens(300_000, 1_000), NOW)).toBe(
		300_000 * 10 + 1_000 * 45,
	);
	expect(requestCost("openai", "gpt-5.5", tokens(300_000, 1_000), NOW, true)).toBe(
		300_000 * 5 + 1_000 * 30,
	);
});

it("uses the prices of the day the request ran", () => {
	expect(priceOf("google", "gemini-4-argon", day("2026-11-30"))?.input).toBe(2);
	expect(priceOf("google", "gemini-4-argon", day("2026-12-01"))?.input).toBe(4);
});

it("knows a dated snapshot of a listed model, and nothing it does not list", () => {
	expect(priceOf("anthropic", "claude-haiku-4-5-20251001", NOW)?.input).toBe(1);
	expect(priceOf("openai", "gpt-5-2025-08-07", NOW)?.input).toBe(1.25);
	expect(priceOf("google", "models/gemini-2.5-flash", NOW)?.input).toBe(0.3);
	// A variant can cost something else, so it gets no estimate rather than its base's.
	expect(priceOf("openai", "gpt-5-codex", NOW)).toBeNull();
	expect(requestCost("anthropic", "claude-next", tokens(10, 10), NOW)).toBeNull();
});

it("lists sensible prices", () => {
	for (const [provider, models] of Object.entries(MODEL_PRICES)) {
		for (const [model, listed] of Object.entries(models)) {
			const periods = Array.isArray(listed) ? listed : [listed];
			for (const price of periods) {
				expect(price.input, model).toBeGreaterThan(0);
				expect(price.output, model).toBeGreaterThanOrEqual(price.input);
				// Workers AI lists no cached rate for most models, so cached input costs what input does.
				if (provider === "workers-ai")
					expect(price.cacheRead, model).toBeLessThanOrEqual(price.input);
				else expect(price.cacheRead, model).toBeLessThan(price.input);
				if (price.long) expect(price.long.input, model).toBeGreaterThan(price.input);
			}
			const days = periods.map((price) => price.since ?? "");
			expect(days, model).toEqual([...days].sort());
		}
	}
});

it("prices the Workers AI models the catalog lists, and no others", () => {
	const at = day("2026-10-29");
	// A million tokens in and out, at the catalog's per-million rates.
	const million = tokens(1_000_000, 1_000_000);
	expect(requestCost("workers-ai", "@cf/meta/llama-4-scout-17b-16e-instruct", million, at)).toBe(
		1_120_000,
	);
	expect(requestCost("workers-ai", "@cf/openai/gpt-oss-120b", million, at)).toBe(1_100_000);
	expect(requestCost("workers-ai", "@cf/openai/gpt-oss-20b", million, at)).toBe(500_000);
	expect(requestCost("workers-ai", "@cf/qwen/qwen3-30b-a3b-fp8", million, at)).toBe(385_900);
	expect(requestCost("workers-ai", "@cf/zai-org/glm-4.7-flash", million, at)).toBe(460_500);
	expect(requestCost("workers-ai", "@cf/moonshotai/kimi-k2.6", million, at)).toBe(4_950_000);
	// Kimi lists a cached rate; the other models bill cached input as input.
	expect(
		requestCost("workers-ai", "@cf/moonshotai/kimi-k2.6", tokens(1_000_000, 0, 500_000), at),
	).toBe(475_000 + 80_000);
	expect(
		requestCost("workers-ai", "@cf/openai/gpt-oss-20b", tokens(1_000_000, 0, 500_000), at),
	).toBe(200_000);
	// Any other model costs what an unknown model of any provider does: no estimate.
	expect(requestCost("workers-ai", "@cf/meta/llama-3.1-8b-instruct", million, at)).toBeNull();
	// Prices belong to a provider: the same id under another one is not listed.
	expect(priceOf("openai", "@cf/openai/gpt-oss-20b", at)).toBeNull();
});
