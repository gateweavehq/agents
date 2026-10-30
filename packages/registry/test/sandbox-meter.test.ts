import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SANDBOX_SECOND_PRICE } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { SandboxMeterDO } from "../src";

// Each test has a meter of its own; the deployment has one.
const meter = () => env.SANDBOX_METER.getByName(crypto.randomUUID());

describe("the sandbox meter", () => {
	it("adds up each workspace's latest figure for the month, priced by the second", async () => {
		const stub = meter();
		expect((await stub.record("2026-10", "ws-1", 100, null)).spent).toBeCloseTo(
			100 * SANDBOX_SECOND_PRICE,
			12,
		);
		expect((await stub.record("2026-10", "ws-2", 50, null)).spent).toBeCloseTo(
			150 * SANDBOX_SECOND_PRICE,
			12,
		);
		expect((await stub.record("2026-10", "ws-1", 300, null)).spent).toBeCloseTo(
			350 * SANDBOX_SECOND_PRICE,
			12,
		);
		// A report that arrives late does not take back time a later one counted.
		expect((await stub.record("2026-10", "ws-1", 200, null)).spent).toBeCloseTo(
			350 * SANDBOX_SECOND_PRICE,
			12,
		);
		// A month starts from nothing.
		expect((await stub.record("2026-11", "ws-1", 10, null)).spent).toBeCloseTo(
			10 * SANDBOX_SECOND_PRICE,
			12,
		);
	});

	it("passes each share of the budget once a month, whichever workspace reaches it", async () => {
		const stub = meter();
		const budget = 1000 * SANDBOX_SECOND_PRICE;
		expect((await stub.record("2026-10", "ws-1", 700, budget)).passed).toEqual([]);
		expect((await stub.record("2026-10", "ws-1", 800, budget)).passed).toEqual([80]);
		expect((await stub.record("2026-10", "ws-2", 100, budget)).passed).toEqual([]);
		expect((await stub.record("2026-10", "ws-2", 250, budget)).passed).toEqual([100]);
		expect((await stub.record("2026-10", "ws-1", 2000, budget)).passed).toEqual([]);
		// A month that starts past the budget hears of both at once.
		expect((await stub.record("2026-11", "ws-1", 2000, budget)).passed).toEqual([80, 100]);
		// Without a budget, there is nothing to pass.
		expect((await stub.record("2026-12", "ws-1", 2000, null)).passed).toEqual([]);
	});

	it("takes only figures", async () => {
		await runInDurableObject(meter(), (instance: SandboxMeterDO) => {
			expect(() => instance.record("October", "ws-1", 1, null)).toThrow();
			expect(() => instance.record("2026-10", "ws-1", -1, null)).toThrow();
			expect(() => instance.record("2026-10", "ws-1", Number.NaN, null)).toThrow();
			expect(() => instance.record("2026-10", "", 1, null)).toThrow();
			expect(instance.record("2026-10", "ws-1", 0, null).spent).toBe(0);
		});
	});
});
