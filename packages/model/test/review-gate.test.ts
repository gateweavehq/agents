import { REVIEW_GATE, reviewGateLine, reviewGatePassed } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";

describe("the review replay gate", () => {
	it("keeps the ready-made card hidden while no run has passed", () => {
		expect(REVIEW_GATE.passed).toBeNull();
		expect(reviewGatePassed()).toBe(false);
	});

	it("shows a passed run's date, engine and model, hits out of 35 and real share", () => {
		const line = reviewGateLine({
			date: "2026-11-20",
			engine: "Gateweave",
			model: "claude-sonnet-5-5",
			hits: 17,
			realShare: 0.6,
		});
		expect(line).toContain("2026-11-20");
		expect(line).toContain("Gateweave on claude-sonnet-5-5");
		expect(line).toContain("17 of 35 seeded defects");
		expect(line).toContain("60% of the reviews real");
	});
});
