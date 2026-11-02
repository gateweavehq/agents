import { describe, expect, it } from "vitest";
import { devin } from "../src/devin";
import { agentOf, assetOf, expectValid, repo } from "./support";

const TEST_RULE = `---
trigger: glob
globs: "**/*.test.ts"
description: How we write tests
---
Use vitest.
`;

describe("devin adapter", () => {
	it("reads Devin's rules with their trigger, and Windsurf's as legacy", () => {
		const detection = devin.detect(
			repo({
				".devin/rules/testing.md": TEST_RULE,
				".devin/rules/team/style.md": "---\ntrigger: always_on\n---\nBe brief.\n",
				".windsurf/rules/old.md":
					"---\ntrigger: model_decision\ndescription: Old rule\n---\nOld.\n",
				".devin/rules/notes.txt": "Not a rule.",
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(assetOf(detection, ".devin/rules/testing.md")).toMatchObject({
			kind: "instructions",
			name: "testing",
			description: "How we write tests",
			metadata: { trigger: "glob", globs: ["**/*.test.ts"] },
		});
		expect(assetOf(detection, ".devin/rules/team/style.md")).toMatchObject({
			name: "team/style",
			metadata: { trigger: "always_on" },
		});
		expect(assetOf(detection, ".windsurf/rules/old.md")).toMatchObject({
			description: "Old rule",
			metadata: { trigger: "model_decision", legacy: true },
		});
		expect(detection.assets.map((asset) => asset.key)).not.toContain(".devin/rules/notes.txt");
		expect(agentOf(detection)).toMatchObject({ runtime: "devin", name: "Devin" });
	});

	it("reads Windsurf's global rules only when Devin has none of its own", () => {
		const both = devin.detect(
			repo({
				".devin/global_rules.md": "Devin's.\n",
				".windsurf/global_rules.md": "Windsurf's.\n",
			}),
		);
		expectValid(both);
		expect(agentOf(both).assets).toEqual([".devin/global_rules.md"]);

		const legacy = devin.detect(
			repo({ ".windsurf/global_rules.md": "Windsurf's.\n", ".windsurfrules": "Tabs.\n" }),
		);
		expectValid(legacy);
		expect(assetOf(legacy, ".windsurf/global_rules.md").metadata).toEqual({ legacy: true });
		expect(assetOf(legacy, ".windsurfrules")).toMatchObject({
			metadata: { legacy: true },
			files: [{ path: ".windsurfrules", content: "Tabs.\n" }],
		});
	});

	it("reads .devin/config.json without secrets", () => {
		const detection = devin.detect(
			repo({
				".devin/config.json": JSON.stringify({
					read_config_from: { cursor: false },
					env: { API_TOKEN: "devinEnvSecret" },
				}),
			}),
		);
		expectValid(detection);
		expect(assetOf(detection, ".devin/config.json")).toMatchObject({
			kind: "settings",
			metadata: { env: ["API_TOKEN"] },
		});
		expect(JSON.stringify(detection)).not.toContain("devinEnvSecret");
	});

	it("links AGENTS.md and AGENT.md only once Devin is there", () => {
		const shared = { "AGENTS.md": "Shared.\n", "web/AGENT.md": "Web.\n" };
		expect(devin.detect(repo(shared)).agents).toEqual([]);
		const detection = devin.detect(repo({ ...shared, ".windsurfrules": "Tabs.\n" }));
		expectValid(detection);
		expect(agentOf(detection).assets).toEqual([".windsurfrules", "AGENTS.md", "web/AGENT.md"]);
	});

	it("reports broken files and skips them", () => {
		const detection = devin.detect(
			repo({
				".devin/rules/ok.md": "Fine.\n",
				".devin/config.json": "{ nope",
				".devin/rules/image.md": null,
			}),
		);
		expectValid(detection);
		expect(detection.problems.map((problem) => problem.path).sort()).toEqual([
			".devin/config.json",
			".devin/rules/image.md",
		]);
		expect(agentOf(detection).assets).toEqual([".devin/rules/ok.md"]);
	});

	it("wants only Devin's and Windsurf's files and the ones it shares", () => {
		for (const path of [
			".devin/rules/a.md",
			".devin/global_rules.md",
			".devin/config.json",
			".windsurf/rules/a.md",
			".windsurf/global_rules.md",
			".windsurfrules",
			"AGENTS.md",
			"pkg/AGENT.md",
		]) {
			expect(devin.wants(path), path).toBe(true);
		}
		for (const path of [
			".devin/config.local.json",
			"AGENTS.local.md",
			".devin/rules/a.txt",
			".windsurf/workflows/release.md",
			"README.md",
		]) {
			expect(devin.wants(path), path).toBe(false);
		}
	});
});
