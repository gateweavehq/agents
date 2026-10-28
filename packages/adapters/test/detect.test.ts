import { describe, expect, it } from "vitest";
import { detect, wantsFile } from "../src";
import { agentOf, assetOf, expectValid, repo } from "./support";

const SECRETS = ["mixedEnvSecret", "mixedHeaderSecret", "mixedTomlSecret"];

const MIXED = repo({
	"AGENTS.md": "# Agents\nShared rules.\n",
	"CLAUDE.md": "@AGENTS.md\n\nClaude only.\n",
	"GEMINI.md": "# Gemini\n",
	".gemini/settings.json": JSON.stringify({ context: { fileName: ["AGENTS.md", "GEMINI.md"] } }),
	".cursor/rules/style.mdc": "---\ndescription: Style\nalwaysApply: true\n---\nTabs.\n",
	".cursor/mcp.json": JSON.stringify({
		mcpServers: {
			docs: { url: "https://example.com/mcp", headers: { Authorization: "mixedHeaderSecret" } },
		},
	}),
	".claude/settings.json": JSON.stringify({ env: { KEY: "mixedEnvSecret" } }),
	".claude/agents/reviewer.md":
		"---\nname: reviewer\ndescription: Reviews.\nmodel: sonnet\n---\nReview.\n",
	".codex/config.toml":
		'[mcp_servers.x]\ncommand = "x"\n[mcp_servers.x.env]\nTOKEN = "mixedTomlSecret"\n',
	".agents/skills/shared/SKILL.md":
		"---\nname: shared\ndescription: Used by several agents.\n---\n",
	".agents/skills/shared/notes.md": "Notes.\n",
	"src/index.ts": "export {};\n",
	"node_modules/pkg/CLAUDE.md": "vendored",
});

describe("detect", () => {
	it("merges the adapters of a repository with several agents", () => {
		const detection = detect(MIXED);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(detection.agents.map((agent) => `${agent.runtime}:${agent.key}`)).toEqual([
			"claude-code:main",
			"claude-code:.claude/agents/reviewer.md",
			"codex:main",
			"gemini-cli:main",
			"cursor:main",
		]);

		// One asset per key, though three agents read AGENTS.md and four read the shared skill.
		const keys = detection.assets.map((asset) => asset.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toEqual([...keys].sort());
		expect(keys.filter((key) => key === "AGENTS.md")).toHaveLength(1);
		expect(keys).not.toContain("node_modules/pkg/CLAUDE.md");

		expect(agentOf(detection).assets).toContain("AGENTS.md");
		expect(agentOf(detection, "main").assets).toEqual(
			expect.arrayContaining(["AGENTS.md", "CLAUDE.md", ".claude/settings.json"]),
		);
		const codex = detection.agents.find((agent) => agent.runtime === "codex");
		expect(codex?.assets).toEqual([
			".agents/skills/shared",
			".codex/config.toml",
			".codex/config.toml#x",
			"AGENTS.md",
		]);
		const gemini = detection.agents.find((agent) => agent.runtime === "gemini-cli");
		expect(gemini?.assets).toEqual([
			".agents/skills/shared",
			".gemini/settings.json",
			"AGENTS.md",
			"GEMINI.md",
		]);
		const cursor = detection.agents.find((agent) => agent.runtime === "cursor");
		expect(cursor?.assets).toEqual([
			".agents/skills/shared",
			".cursor/mcp.json#docs",
			".cursor/rules/style.mdc",
			"AGENTS.md",
		]);

		expect(assetOf(detection, ".agents/skills/shared").files.map((file) => file.path)).toEqual([
			"SKILL.md",
			"notes.md",
		]);
	});

	it("keeps every secret out of the output", () => {
		const text = JSON.stringify(detect(MIXED));
		for (const secret of SECRETS) expect(text).not.toContain(secret);
	});

	it("gives the same result however the tree is ordered", () => {
		const reversed = new Map([...MIXED].reverse());
		expect(detect(reversed)).toEqual(detect(MIXED));
	});

	it("finds nothing in a repository without agent files", () => {
		const detection = detect(repo({ "README.md": "# Hi\n", "src/a.ts": "" }));
		expect(detection).toEqual({ agents: [], assets: [], problems: [] });
		expectValid(detection);
	});

	it("finds only Codex in a repository with just AGENTS.md", () => {
		const detection = detect(repo({ "AGENTS.md": "# Agents\n" }));
		expectValid(detection);
		expect(detection.agents.map((agent) => agent.runtime)).toEqual(["codex"]);
	});

	it("reports each problem once", () => {
		const detection = detect(
			repo({
				".agents/skills/bad/SKILL.md": "---\nname: [x\n---\n",
				"AGENTS.md": "# A\n",
				".cursor/rules/r.mdc": "---\nalwaysApply: true\n---\n",
			}),
		);
		expectValid(detection);
		// Codex and Cursor both read the shared skills folder.
		expect(
			detection.problems.filter((problem) => problem.path === ".agents/skills/bad/SKILL.md"),
		).toHaveLength(1);
	});

	it("never exceeds the model's limits on a large repository", () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 150; index++) files[`pkg${index}/AGENTS.md`] = "x";
		for (let index = 0; index < 150; index++) files[`pkg${index}/.claude/settings.json`] = "{";
		const detection = detect(repo(files));
		expect(detection.problems.length).toBeLessThanOrEqual(100);
		expect(detection.assets).toHaveLength(150);
	});
});

describe("wantsFile", () => {
	it("says yes for the files adapters read", () => {
		for (const path of [
			"AGENTS.md",
			"CLAUDE.md",
			"GEMINI.md",
			"deep/er/AGENTS.md",
			".mcp.json",
			".claude/settings.json",
			".claude/skills/review/scripts/run.sh",
			".claude/agents/a.md",
			".claude/commands/a.md",
			".codex/config.toml",
			".agents/skills/x/SKILL.md",
			".gemini/settings.json",
			".gemini/commands/a.toml",
			".cursor/rules/a.mdc",
			".cursor/mcp.json",
			".cursorrules",
		]) {
			expect(wantsFile(path), path).toBe(true);
		}
	});

	it("says no for everything else", () => {
		for (const path of [
			"README.md",
			"src/index.ts",
			"package.json",
			"CLAUDE.local.md",
			".claude/settings.local.json",
			".claude/skills/review/.env",
			"node_modules/pkg/AGENTS.md",
			"agents.md",
			".cursor/rules/a.md",
			".gemini/commands/a.md",
		]) {
			expect(wantsFile(path), path).toBe(false);
		}
	});

	it("wants every file the detection of a mixed repository reads", () => {
		const unwanted = detect(MIXED).assets.flatMap((asset) =>
			asset.files
				.filter((file) => file.content !== undefined)
				.map((file) =>
					asset.path.endsWith(`/${file.path}`) || asset.path === file.path
						? asset.path
						: `${asset.path}/${file.path}`,
				)
				.filter((path) => !wantsFile(path.replace(/#.*/, ""))),
		);
		expect(unwanted).toEqual([]);
	});
});
