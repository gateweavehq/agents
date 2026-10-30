import { describe, expect, it } from "vitest";
import { SANDBOX_SECOND_PRICE, sandboxLimits, sandboxOfferTo } from "../src";

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
		expect(sandboxLimits({})).toEqual({ dailyMinutes: null, monthlyBudget: null });
		expect(
			sandboxLimits({ SANDBOX_DAILY_MINUTES: " 120 ", SANDBOX_MONTHLY_BUDGET: "100" }),
		).toEqual({
			dailyMinutes: 120,
			monthlyBudget: 100,
		});
		expect(sandboxLimits({ SANDBOX_DAILY_MINUTES: "", SANDBOX_MONTHLY_BUDGET: "0" })).toEqual({
			dailyMinutes: null,
			monthlyBudget: 0,
		});
		expect(sandboxLimits({ SANDBOX_DAILY_MINUTES: "2h", SANDBOX_MONTHLY_BUDGET: "-5" })).toEqual({
			dailyMinutes: 0,
			monthlyBudget: 0,
		});
		// Wrangler hands a number in `vars` over as one.
		expect(sandboxLimits({ SANDBOX_DAILY_MINUTES: 90 as unknown as string }).dailyMinutes).toBe(90);
	});

	it("prices a second of sandbox at the most its machine costs", () => {
		// $0.074 an hour: 4 GiB of memory, half a vCPU kept busy and 8 GB of disk.
		expect(SANDBOX_SECOND_PRICE * 3600).toBeCloseTo(0.074016, 6);
	});
});
