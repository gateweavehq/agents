import { describe, expect, it } from "vitest";
import {
	agentDefinitionInput,
	FILES_WITH_SANDBOX,
	filesOffered,
	MAX_SANDBOX_STEPS,
	MAX_STEPS,
} from "../src";

const agent = (fields: object = {}) => ({
	name: "Builder",
	description: null,
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	instructions: null,
	...fields,
});

describe("an agent's files setting", () => {
	it("is off unless it is sent, and comes last, after what an agent had before it", () => {
		const parsed = agentDefinitionInput.parse(agent());
		expect(parsed.files).toBe(false);
		expect(Object.keys(parsed).at(-1)).toBe("files");
		expect(agentDefinitionInput.parse(agent({ files: true })).files).toBe(true);
		expect(agentDefinitionInput.safeParse(agent({ files: "yes" })).success).toBe(false);
	});

	it("is never had with a sandbox", () => {
		const both = agentDefinitionInput.safeParse(agent({ files: true, sandbox: true }));
		expect(both.success).toBe(false);
		expect(both.error?.issues).toMatchObject([{ message: FILES_WITH_SANDBOX, path: ["files"] }]);
		expect(FILES_WITH_SANDBOX).toBe(
			"An agent works on files without a sandbox or has a sandbox, not both",
		);
		// Either alone is the registry's to judge, with the repository it knows.
		expect(agentDefinitionInput.safeParse(agent({ files: true })).success).toBe(true);
		expect(agentDefinitionInput.safeParse(agent({ sandbox: true })).success).toBe(true);
		expect(agentDefinitionInput.safeParse(agent({ files: false, sandbox: true })).success).toBe(
			true,
		);
	});

	it("leaves the schema's fields where other schemas read them", () => {
		expect(agentDefinitionInput.shape.model.safeParse("claude-sonnet-5-5").success).toBe(true);
	});
});

describe("a deployment's files setting", () => {
	it("is on only as 1, so a mistyped value never turns it on", () => {
		expect(filesOffered({})).toBe(false);
		for (const value of ["", "0", "true", "yes", "on", "11", "1.0", "1,1", 0, true, null]) {
			expect(filesOffered({ FILES_ONLY_RUNS: value })).toBe(false);
		}
		// Only text is read: a number or a list that reads as `1` once made text is off.
		for (const value of [1, ["1"], [1], { toString: () => "1" }, new String("1")]) {
			expect(filesOffered({ FILES_ONLY_RUNS: value })).toBe(false);
		}
		// Space around it is trimmed, as around the other settings.
		for (const value of ["1", " 1", "1 ", "1\n", "\t1 "]) {
			expect(filesOffered({ FILES_ONLY_RUNS: value })).toBe(true);
		}
	});
});

describe("a turn's steps", () => {
	it("are ten, and forty where the work goes in many small steps", () => {
		expect(MAX_STEPS).toBe(10);
		expect(MAX_SANDBOX_STEPS).toBe(40);
	});
});
