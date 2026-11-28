import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REVIEW_SETUP_RUNS_PER_DAY } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");
const doc = (name: string) =>
	readFileSync(resolve(ROOT, "docs", name), "utf8").replace(/\s+/g, " ");

describe("the pull request review docs", () => {
	it("say what the reviewer is and who pays", () => {
		for (const name of ["pull-request-review.md", "architecture.md"]) {
			const text = doc(name);
			expect(text).toContain("a second reader, never the approval");
			expect(text).toContain("workspace's provider key");
			expect(text).toContain("sandbox minutes");
		}
	});

	it("says who sets it up, what the gate shows and what the trigger allows", () => {
		const text = doc("pull-request-review.md");
		expect(text).toContain("Review is off until an owner or admin sets it up");
		expect(text).toContain("one repository at a time");
		expect(text).toContain("memory off");
		expect(text).toContain("35 seeded defects");
		expect(text).toContain(`${REVIEW_SETUP_RUNS_PER_DAY} runs a day`);
	});
});
