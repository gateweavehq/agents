import { describe, expect, it } from "vitest";
import {
	MODEL_PRICES,
	pricedModels,
	priceOf,
	WORKERS_AI_REMOVED,
	workersAiRemoved,
	workersAiRemovedMessage,
} from "../src";

describe("the Workers AI models Cloudflare removed", () => {
	it("are Workers AI ids, each with the day it stops answering", () => {
		const removed = Object.entries(WORKERS_AI_REMOVED);
		// The sixteen text models of the changelog entry of 2026-11-05.
		expect(removed.length).toBeGreaterThanOrEqual(16);
		for (const [model, day] of removed) {
			expect(model).toMatch(/^@cf\/[\w.-]+\/[\w.-]+$/);
			expect(day, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10), model).toBe(day);
		}
		expect(workersAiRemoved("@cf/moonshotai/kimi-k2.6")).toBe(true);
		expect(workersAiRemoved("@cf/qwen/qwen3-30b-a3b-fp8")).toBe(true);
		expect(workersAiRemoved("@cf/meta/llama-4-scout-17b-16e-instruct")).toBe(false);
		// Not a name every object has.
		expect(workersAiRemoved("toString")).toBe(false);
	});

	it("are not listed on the demo, and have prices only until their day", () => {
		// The demo's model picker lists the models that have prices.
		const listed = pricedModels("workers-ai");
		expect(listed.length).toBeGreaterThan(0);
		for (const [model, day] of Object.entries(WORKERS_AI_REMOVED)) {
			expect(listed, model).not.toContain(model);
			expect(priceOf("workers-ai", model, Date.parse(`${day}T00:00:00Z`)), model).toBeNull();
			// One that had prices keeps them to the day and no longer, so its runs count until then.
			const priced = MODEL_PRICES["workers-ai"][model];
			if (priced !== undefined) expect([priced].flat().at(-1)?.until, model).toBe(day);
		}
	});

	it("say what happened and what to do, with the day when it is known", () => {
		expect(workersAiRemovedMessage("@cf/moonshotai/kimi-k2.6")).toBe(
			"Cloudflare removed @cf/moonshotai/kimi-k2.6 from Workers AI on 20 November 2026. Choose another model in the agent's settings.",
		);
		// A model Cloudflare removed that this list does not know yet.
		expect(workersAiRemovedMessage("@cf/acme/gone")).toBe(
			"Cloudflare removed @cf/acme/gone from Workers AI. Choose another model in the agent's settings.",
		);
		expect(workersAiRemovedMessage("constructor")).not.toContain(" on ");
	});
});
