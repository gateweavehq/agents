import { describe, expect, it } from "vitest";
import { geminiCli } from "../src/gemini-cli";
import { agentOf, assetOf, expectValid, repo } from "./support";

const SETTINGS = JSON.stringify({
	model: { name: "gemini-2.5-pro" },
	context: { fileName: ["AGENTS.md", "GEMINI.md"] },
	mcpServers: {
		github: {
			command: "docker",
			args: [
				"run",
				"-i",
				"--rm",
				"-e",
				"GITHUB_PERSONAL_ACCESS_TOKEN",
				"ghcr.io/github/github-mcp-server",
			],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_geminiSecret" },
		},
		remote: {
			httpUrl: "https://example.com/mcp",
			headers: { Authorization: "Bearer geminiHeaderSecret" },
			timeout: 5000,
			trust: true,
		},
	},
});

describe("gemini cli adapter", () => {
	it("finds an agent from GEMINI.md", () => {
		const detection = geminiCli.detect(
			repo({ "GEMINI.md": "# Context\n", "docs/GEMINI.md": "# Docs\n" }),
		);
		expectValid(detection);
		expect(agentOf(detection)).toMatchObject({
			runtime: "gemini-cli",
			name: "Gemini CLI",
			assets: ["GEMINI.md", "docs/GEMINI.md"],
		});
	});

	it("does not treat AGENTS.md as Gemini's own", () => {
		const detection = geminiCli.detect(repo({ "AGENTS.md": "# Agents\n" }));
		expect(detection).toEqual({ agents: [], assets: [], problems: [] });
	});

	it("reads settings, MCP servers and the context files the settings name", () => {
		const detection = geminiCli.detect(
			repo({
				".gemini/settings.json": SETTINGS,
				"AGENTS.md": "# Agents\n",
				"GEMINI.md": "# Gemini\n",
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		const main = agentOf(detection);
		expect(main.model).toBe("gemini-2.5-pro");
		expect(main.assets).toEqual([
			".gemini/settings.json",
			".gemini/settings.json#github",
			".gemini/settings.json#remote",
			"AGENTS.md",
			"GEMINI.md",
		]);
		expect(assetOf(detection, ".gemini/settings.json").metadata).toMatchObject({
			contextFileName: ["AGENTS.md", "GEMINI.md"],
			mcpServers: ["github", "remote"],
		});
		expect(assetOf(detection, ".gemini/settings.json#remote").metadata).toEqual({
			type: "http",
			httpUrl: "https://example.com/mcp",
			headers: ["Authorization"],
			timeout: 5000,
			trust: true,
		});
		const everything = JSON.stringify(detection);
		expect(everything).not.toContain("ghp_geminiSecret");
		expect(everything).not.toContain("geminiHeaderSecret");
	});

	it("reads only the files context.fileName names", () => {
		const detection = geminiCli.detect(
			repo({
				".gemini/settings.json": JSON.stringify({ context: { fileName: "CONTEXT.md" } }),
				"GEMINI.md": "# Gemini\n",
				"CONTEXT.md": null,
			}),
		);
		expectValid(detection);
		// GEMINI.md is Gemini's file but is not read; CONTEXT.md is read though the scanner never
		// downloaded it, so it is given by blob and size.
		expect(agentOf(detection).assets).toEqual([".gemini/settings.json", "CONTEXT.md"]);
		expect(assetOf(detection, "CONTEXT.md").files[0]?.content).toBeUndefined();
		expect(detection.assets.map((asset) => asset.key)).toContain("GEMINI.md");
		expect(detection.problems).toEqual([]);
	});

	it("reads custom commands as prompts, namespaced by folder", () => {
		const detection = geminiCli.detect(
			repo({
				".gemini/commands/git/commit.toml":
					'description = "Commit work"\nprompt = "Write a commit for !{git diff}"\n',
				".gemini/commands/plan.toml": 'prompt = "Plan {{args}}"\n',
				".gemini/commands/broken.toml": 'description = "No prompt"\n',
			}),
		);
		expectValid(detection);
		expect(assetOf(detection, ".gemini/commands/git/commit.toml")).toMatchObject({
			kind: "prompt",
			name: "git:commit",
			description: "Commit work",
			files: [{ path: "commit.toml" }],
		});
		expect(assetOf(detection, ".gemini/commands/plan.toml").description).toBeNull();
		expect(detection.problems).toEqual([
			{ path: ".gemini/commands/broken.toml", message: "The command has no prompt" },
		]);
	});

	it("reads skills from .gemini/skills and .agents/skills", () => {
		const detection = geminiCli.detect(
			repo({
				".gemini/skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\n",
				".agents/skills/b/SKILL.md": "---\nname: b\ndescription: B\n---\n",
			}),
		);
		expectValid(detection);
		expect(agentOf(detection).assets).toEqual([".agents/skills/b", ".gemini/skills/a"]);
	});

	it("reports invalid settings and carries on", () => {
		const detection = geminiCli.detect(
			repo({ ".gemini/settings.json": "{ // comment\n}", "GEMINI.md": "# Hi\n" }),
		);
		expectValid(detection);
		expect(detection.problems.map((problem) => problem.path)).toEqual([".gemini/settings.json"]);
		expect(agentOf(detection).assets).toEqual(["GEMINI.md"]);
	});

	it("asks for the files it reads and no others", () => {
		for (const path of [
			"GEMINI.md",
			"a/GEMINI.md",
			".gemini/settings.json",
			".gemini/commands/a/b.toml",
			".gemini/skills/x/SKILL.md",
			".agents/skills/x/SKILL.md",
		]) {
			expect(geminiCli.wants(path), path).toBe(true);
		}
		for (const path of [
			"gemini.md",
			".gemini/commands/a.md",
			".gemini/.env",
			"settings.json",
			".gemini/sandbox.Dockerfile",
		]) {
			expect(geminiCli.wants(path), path).toBe(false);
		}
	});
});
