import { describe, expect, it } from "vitest";
import {
	SANDBOX_IDLE_MINUTES,
	SANDBOX_SECOND_PRICE,
	sandboxCost,
	sandboxIdleMinutes,
	sandboxLimits,
	sandboxOfferTo,
	sandboxRunSeconds,
} from "../src";

describe("sandbox settings", () => {
	const binding = {};

	it("offers none without the binding, whoever is invited", () => {
		expect(sandboxOfferTo({}, "ws-1")).toBe("none");
		expect(sandboxOfferTo({ SANDBOX_WORKSPACES: "ws-1" }, "ws-1")).toBe("none");
	});

	it("offers them to every workspace when the server invites none in particular", () => {
		expect(sandboxOfferTo({ SANDBOX: binding }, "ws-1")).toBe("offered");
		expect(sandboxOfferTo({ SANDBOX: binding, SANDBOX_WORKSPACES: " , " }, "ws-1")).toBe("offered");
	});

	it("offers them only to the workspaces it names, by commas or spaces", () => {
		const settings = { SANDBOX: binding, SANDBOX_WORKSPACES: "ws-1, ws-2\nws-3" };
		for (const workspace of ["ws-1", "ws-2", "ws-3"]) {
			expect(sandboxOfferTo(settings, workspace)).toBe("offered");
		}
		expect(sandboxOfferTo(settings, "ws-4")).toBe("by-invitation");
		// A name is whole: a part of one invites nobody.
		expect(sandboxOfferTo(settings, "ws")).toBe("by-invitation");
		expect(sandboxOfferTo(settings, "")).toBe("by-invitation");
	});

	it("reads the limits as numbers, and a mistyped one as allowing nothing", () => {
		expect(sandboxLimits({})).toEqual({
			dailyMinutes: null,
			monthlyMinutes: null,
			monthlyBudget: null,
		});
		expect(
			sandboxLimits({ SANDBOX_DAILY_MINUTES: " 120 ", SANDBOX_MONTHLY_BUDGET: "100" }),
		).toEqual({
			dailyMinutes: 120,
			monthlyMinutes: null,
			monthlyBudget: 100,
		});
		expect(sandboxLimits({ SANDBOX_DAILY_MINUTES: "", SANDBOX_MONTHLY_BUDGET: "0" })).toEqual({
			dailyMinutes: null,
			monthlyMinutes: null,
			monthlyBudget: 0,
		});
		expect(sandboxLimits({ SANDBOX_DAILY_MINUTES: "2h", SANDBOX_MONTHLY_BUDGET: "-5" })).toEqual({
			dailyMinutes: 0,
			monthlyMinutes: null,
			monthlyBudget: 0,
		});
		// Wrangler hands a number in `vars` over as one.
		expect(sandboxLimits({ SANDBOX_DAILY_MINUTES: 90 as unknown as string }).dailyMinutes).toBe(90);
	});

	it("reads the monthly minutes limit from either a string or a number", () => {
		expect(sandboxLimits({ SANDBOX_MONTHLY_MINUTES: "" }).monthlyMinutes).toBeNull();
		expect(sandboxLimits({ SANDBOX_MONTHLY_MINUTES: "300" }).monthlyMinutes).toBe(300);
		expect(
			sandboxLimits({ SANDBOX_MONTHLY_MINUTES: 300 as unknown as string }).monthlyMinutes,
		).toBe(300);
		expect(sandboxLimits({ SANDBOX_MONTHLY_MINUTES: "abc" }).monthlyMinutes).toBe(0);
	});

	it("reads the idle minutes as a number, and a mistyped one as the default", () => {
		expect(sandboxIdleMinutes({})).toBe(SANDBOX_IDLE_MINUTES);
		expect(sandboxIdleMinutes({ SANDBOX_IDLE_MINUTES: "" })).toBe(SANDBOX_IDLE_MINUTES);
		expect(sandboxIdleMinutes({ SANDBOX_IDLE_MINUTES: " 8 " })).toBe(8);
		expect(sandboxIdleMinutes({ SANDBOX_IDLE_MINUTES: "2.5" })).toBe(2.5);
		// A sandbox that would stop at once would lose every turn's checkout, and one over five
		// hours would break the container's timeout with an engine turn's hour on top: a mistyped
		// value keeps the default instead.
		for (const mistyped of ["0", "-3", "soon", "301", "1000"]) {
			expect(sandboxIdleMinutes({ SANDBOX_IDLE_MINUTES: mistyped })).toBe(SANDBOX_IDLE_MINUTES);
		}
		expect(sandboxIdleMinutes({ SANDBOX_IDLE_MINUTES: "300" })).toBe(300);
		// Wrangler hands a number in `vars` over as one.
		expect(sandboxIdleMinutes({ SANDBOX_IDLE_MINUTES: 10 as unknown as string })).toBe(10);
	});

	it("prices a second of sandbox at the most its machine costs", () => {
		// $0.074 an hour: 4 GiB of memory, half a vCPU kept busy and 8 GB of disk.
		expect(SANDBOX_SECOND_PRICE * 3600).toBeCloseTo(0.074016, 6);
	});
});

describe("sandboxRunSeconds", () => {
	const MINUTE = 60_000;
	const run = { sandbox: true, status: "succeeded", startedAt: 0, endedAt: 10 * MINUTE };

	it("counts a run until its conversation's sandbox sleeps, or its next turn takes it over", () => {
		expect(sandboxRunSeconds(run, null, 60 * MINUTE)).toBe((10 + SANDBOX_IDLE_MINUTES) * 60);
		expect(sandboxRunSeconds(run, 12 * MINUTE, 60 * MINUTE)).toBe(12 * 60);
		// The deployment's own idle minutes count instead of the default.
		expect(sandboxRunSeconds(run, null, 60 * MINUTE, 20)).toBe(30 * 60);
	});

	it("counts a run still going until now, and one that never reported back until it timed out", () => {
		const going = { ...run, status: "running", endedAt: null };
		expect(sandboxRunSeconds(going, null, 3 * MINUTE)).toBe(3 * 60);
		// An active run is never cut by the idle minutes, whatever they are.
		expect(sandboxRunSeconds(going, null, 3 * MINUTE, 1)).toBe(3 * 60);
		expect(sandboxRunSeconds(going, null, 5 * 60 * MINUTE)).toBe((60 + SANDBOX_IDLE_MINUTES) * 60);
	});

	it("gives a run without a sandbox none", () => {
		expect(sandboxRunSeconds({ ...run, sandbox: false }, null, 60 * MINUTE)).toBeNull();
	});

	it("prices sandbox time in millionths of a dollar, as runs count cost", () => {
		expect(sandboxCost(3600)).toBe(Math.round(SANDBOX_SECOND_PRICE * 3600 * 1_000_000));
	});
});
