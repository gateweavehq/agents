import { expect, it } from "vitest";
import { importInputOf, readyMadeResults, readyMadeSetups } from "./ready-made";

it("bundles the setup folders, and every one loads", () => {
	const results = readyMadeResults();
	expect(results.map((result) => result.slug)).toEqual(
		expect.arrayContaining(["baseline", "review"]),
	);
	for (const result of results) {
		expect(result.ok, result.ok ? "" : `${result.slug}: ${result.problems.join("; ")}`).toBe(true);
	}
	expect(readyMadeSetups()).toHaveLength(results.length);
});

it("turns each into input the registry accepts", async () => {
	const { setupImportInput } = await import("@gateweave/agents-model");
	for (const setup of readyMadeSetups()) {
		const parsed = setupImportInput.safeParse(importInputOf(setup));
		expect(parsed.success, setup.slug).toBe(true);
	}
});
