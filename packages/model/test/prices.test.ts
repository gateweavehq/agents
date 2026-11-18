import { expect, it } from "vitest";
import { MODEL_PRICES, pricedModels, priceOf, requestCost } from "../src";

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

// Cloudflare removes Kimi K2.6 and Qwen3 30B on 2026-11-20. Until then they answer, and an agent
// saved with one still spends the deployment's money, so its runs must still count.
it("prices a model its provider is removing until the day it goes, and lists it nowhere", () => {
	const million = tokens(1_000_000, 1_000_000);
	const kimi = "@cf/moonshotai/kimi-k2.6";
	const qwen = "@cf/qwen/qwen3-30b-a3b-fp8";
	expect(requestCost("workers-ai", kimi, million, day("2026-11-19"))).toBe(4_950_000);
	expect(requestCost("workers-ai", qwen, million, day("2026-11-19"))).toBe(385_900);
	// Kimi's cached rate still applies.
	expect(requestCost("workers-ai", kimi, tokens(1_000_000, 0, 500_000), day("2026-11-19"))).toBe(
		475_000 + 80_000,
	);
	// To the last second of the day before, and not after.
	expect(priceOf("workers-ai", kimi, Date.parse("2026-11-19T23:59:59Z"))?.input).toBe(0.95);
	expect(priceOf("workers-ai", kimi, Date.parse("2026-11-20T00:00:00Z"))).toBeNull();
	expect(requestCost("workers-ai", qwen, million, day("2026-11-20"))).toBeNull();

	// The demo's model picker lists these.
	const listed = pricedModels("workers-ai");
	expect(listed).toContain("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
	expect(listed).not.toContain(kimi);
	expect(listed).not.toContain(qwen);
	expect(pricedModels("anthropic")).toContain("claude-sonnet-5-5");
	// A price that changes on a day is still a model to choose.
	expect(pricedModels("google")).toContain("gemini-4-argon");
});

it("prices the Workers AI models the catalog lists, and no others", () => {
	const at = day("2026-11-18");
	// A million tokens in and out, at the catalog's per-million rates.
	const million = tokens(1_000_000, 1_000_000);
	expect(requestCost("workers-ai", "@cf/meta/llama-4-scout-17b-16e-instruct", million, at)).toBe(
		1_120_000,
	);
	expect(requestCost("workers-ai", "@cf/openai/gpt-oss-120b", million, at)).toBe(1_100_000);
	expect(requestCost("workers-ai", "@cf/openai/gpt-oss-20b", million, at)).toBe(500_000);
	expect(requestCost("workers-ai", "@cf/zai-org/glm-4.7-flash", million, at)).toBe(460_500);
	expect(requestCost("workers-ai", "@cf/deepseek-ai/deepseek-v4.1-flash-1017", million, at)).toBe(
		1_500_000,
	);
	expect(requestCost("workers-ai", "@cf/qwen/qwen3.8-27b", million, at)).toBe(3_650_000);
	expect(requestCost("workers-ai", "@cf/google/gemma-4-26b-a4b-it", million, at)).toBe(400_000);
	expect(requestCost("workers-ai", "@cf/zai-org/glm-5.3", million, at)).toBe(5_800_000);
	// DeepSeek lists a cached rate; a model that lists none bills cached input as input.
	expect(
		requestCost(
			"workers-ai",
			"@cf/deepseek-ai/deepseek-v4.1-flash-1017",
			tokens(1_000_000, 0, 500_000),
			at,
		),
	).toBe(150_000 + 3_000);
	expect(
		requestCost("workers-ai", "@cf/openai/gpt-oss-20b", tokens(1_000_000, 0, 500_000), at),
	).toBe(200_000);
	// Any other model costs what an unknown model of any provider does: no estimate.
	expect(requestCost("workers-ai", "@cf/meta/llama-3.1-8b-instruct", million, at)).toBeNull();
	// Prices belong to a provider: the same id under another one is not listed.
	expect(priceOf("openai", "@cf/openai/gpt-oss-20b", at)).toBeNull();
});
