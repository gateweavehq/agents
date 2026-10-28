import { describe, expect, it } from "vitest";
import { claudeCode } from "../src/claude-code";
import { agentOf, assetOf, expectValid, repo, textOf } from "./support";

const SKILL = `---
name: review
description: Reviews a diff for bugs. Use before merging.
allowed-tools: Bash(git diff *) Read
disable-model-invocation: true
---
Look at the diff.
`;

const SUBAGENT = `---
name: security-reviewer
description: Looks for security problems in changed code.
tools: Read, Grep
model: opus
---
You review code for vulnerabilities.
`;

const MCP = JSON.stringify({
	mcpServers: {
		github: {
			type: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github", "--token=ghp_argSecret123"],
			env: { GITHUB_TOKEN: "ghp_envSecret456", LOG_LEVEL: "debug" },
		},
		docs: {
			type: "http",
			url: "https://mcp.example.com/mcp?api_key=urlSecret789",
			headers: { Authorization: "Bearer headerSecret000" },
		},
	},
});

describe("claude code adapter", () => {
	it("finds the main agent and what it reads", () => {
		const detection = claudeCode.detect(
			repo({
				"CLAUDE.md": "# Project\n",
				"packages/web/CLAUDE.md": "# Web\n",
				".claude/settings.json": JSON.stringify({
					model: "sonnet",
					permissions: { allow: ["Bash(ls)"] },
				}),
				".claude/skills/review/SKILL.md": SKILL,
				".claude/commands/git/commit.md":
					"---\ndescription: Commit staged work\nargument-hint: <message>\n---\nCommit.\n",
				".claude/commands/ship.md": "# Ship it\nRun the release.\n",
				".claude/rules/testing.md": "---\npaths:\n  - 'src/**/*.test.ts'\n---\nTest behavior.\n",
				".mcp.json": MCP,
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(detection.agents.map((agent) => agent.key)).toEqual(["main"]);
		const main = agentOf(detection);
		expect(main).toMatchObject({
			runtime: "claude-code",
			name: "Claude Code",
			path: null,
			model: "sonnet",
		});
		expect(main.assets).toEqual(
			[
				"CLAUDE.md",
				"packages/web/CLAUDE.md",
				".claude/settings.json",
				".claude/skills/review",
				".claude/commands/git/commit.md",
				".claude/commands/ship.md",
				".claude/rules/testing.md",
				".mcp.json#docs",
				".mcp.json#github",
			].sort(),
		);
		expect(assetOf(detection, ".claude/commands/git/commit.md")).toMatchObject({
			kind: "prompt",
			name: "git:commit",
			description: "Commit staged work",
			metadata: { "argument-hint": "<message>" },
			files: [{ path: "commit.md" }],
		});
		expect(assetOf(detection, ".claude/commands/ship.md").description).toBe("Ship it");
		expect(assetOf(detection, ".claude/rules/testing.md").metadata).toEqual({
			paths: ["src/**/*.test.ts"],
		});
	});

	it("reads a skill with every file in its folder, binary ones by blob and size", () => {
		const detection = claudeCode.detect(
			repo({
				".claude/skills/review/SKILL.md": SKILL,
				".claude/skills/review/checklist.md": "- bugs\n",
				".claude/skills/review/scripts/run.sh": "#!/bin/sh\n",
				".claude/skills/review/diagram.png": null,
				".claude/skills/review/.env": "SECRET=abc",
			}),
		);
		expectValid(detection);
		const skill = assetOf(detection, ".claude/skills/review");
		expect(skill).toMatchObject({
			kind: "skill",
			name: "review",
			description: "Reviews a diff for bugs. Use before merging.",
			path: ".claude/skills/review",
			metadata: { "allowed-tools": "Bash(git diff *) Read", "disable-model-invocation": true },
		});
		expect(skill.files.map((file) => file.path)).toEqual([
			".env",
			"SKILL.md",
			"checklist.md",
			"diagram.png",
			"scripts/run.sh",
		]);
		const png = skill.files.find((file) => file.path === "diagram.png");
		expect(png?.content).toBeUndefined();
		expect(png).toMatchObject({
			blob: expect.stringMatching(/^[0-9a-f]{40}$/),
			size: expect.any(Number),
		});
		// An .env file is never stored, only counted.
		expect(skill.files.find((file) => file.path === ".env")?.content).toBeUndefined();
		expect(JSON.stringify(detection)).not.toContain("SECRET=abc");
	});

	it("names a skill after its folder when the front matter does not", () => {
		const detection = claudeCode.detect(
			repo({ "apps/web/.claude/skills/deploy/SKILL.md": "Deploy it.\n" }),
		);
		expectValid(detection);
		expect(assetOf(detection, "apps/web/.claude/skills/deploy")).toMatchObject({
			name: "deploy",
			description: null,
		});
	});

	it("turns each subagent into an agent that reads its own definition", () => {
		const detection = claudeCode.detect(
			repo({
				".claude/agents/review/security.md": SUBAGENT,
				".claude/agents/plain.md": "No front matter.\n",
			}),
		);
		expectValid(detection);
		expect(agentOf(detection, ".claude/agents/review/security.md")).toMatchObject({
			runtime: "claude-code",
			name: "security-reviewer",
			description: "Looks for security problems in changed code.",
			model: "opus",
			path: ".claude/agents/review/security.md",
			metadata: { tools: "Read, Grep" },
			assets: [".claude/agents/review/security.md"],
		});
		expect(assetOf(detection, ".claude/agents/review/security.md").kind).toBe("instructions");
		expect(agentOf(detection, ".claude/agents/plain.md")).toMatchObject({
			name: "plain",
			model: null,
		});
		// The main agent does not read subagent definitions.
		expect(agentOf(detection).assets).toEqual([]);
	});

	it("keeps secrets out of settings and MCP servers", () => {
		const detection = claudeCode.detect(
			repo({
				".mcp.json": MCP,
				".claude/settings.json": JSON.stringify({
					env: { ANTHROPIC_API_KEY: "sk-settingsSecret" },
					model: "opus",
				}),
			}),
		);
		expectValid(detection);
		const everything = JSON.stringify(detection);
		for (const secret of [
			"ghp_argSecret123",
			"ghp_envSecret456",
			"urlSecret789",
			"headerSecret000",
			"sk-settingsSecret",
		]) {
			expect(everything).not.toContain(secret);
		}
		expect(textOf(detection, ".claude/settings.json")).toBe(
			'{\n  "env": {\n    "ANTHROPIC_API_KEY": "<redacted>"\n  },\n  "model": "opus"\n}\n',
		);
		expect(assetOf(detection, ".mcp.json#github")).toMatchObject({
			kind: "mcp-server",
			name: "github",
			path: ".mcp.json",
			files: [{ path: ".mcp.json" }],
			metadata: {
				type: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github", "--token=<redacted>"],
				env: ["GITHUB_TOKEN", "LOG_LEVEL"],
			},
		});
		expect(JSON.parse(textOf(detection, ".mcp.json#github"))).toEqual({
			args: ["-y", "@modelcontextprotocol/server-github", "--token=<redacted>"],
			command: "npx",
			env: { GITHUB_TOKEN: "<redacted>", LOG_LEVEL: "<redacted>" },
			type: "stdio",
		});
		expect(assetOf(detection, ".mcp.json#docs").metadata).toEqual({
			type: "http",
			url: "https://mcp.example.com/mcp?api_key=<redacted>",
			headers: ["Authorization"],
		});
		expect(textOf(detection, ".mcp.json#docs").endsWith("}\n")).toBe(true);
	});

	it("reads a plugin as its .claude-plugin folder", () => {
		const detection = claudeCode.detect(
			repo({
				"tools/lint/.claude-plugin/plugin.json": JSON.stringify({
					name: "lint-tools",
					description: "Linting helpers",
					version: "1.2.0",
					author: { name: "Example Team" },
					mcpServers: { lint: { command: "lint-mcp", env: { TOKEN: "pluginSecret" } } },
				}),
				"tools/lint/.claude-plugin/icon.png": null,
			}),
		);
		expectValid(detection);
		const plugin = assetOf(detection, "tools/lint/.claude-plugin");
		expect(plugin).toMatchObject({
			kind: "plugin",
			name: "lint-tools",
			description: "Linting helpers",
			metadata: { version: "1.2.0", author: "Example Team" },
		});
		expect(plugin.files.map((file) => file.path)).toEqual(["icon.png", "plugin.json"]);
		expect(JSON.stringify(detection)).not.toContain("pluginSecret");
		expect(agentOf(detection).assets).toEqual(["tools/lint/.claude-plugin"]);
	});

	it("reads AGENTS.md only where Claude Code does", () => {
		const alone = claudeCode.detect(repo({ "AGENTS.md": "# Agents\n", ".mcp.json": MCP }));
		expect(agentOf(alone).assets).toContain("AGENTS.md");
		const shadowed = claudeCode.detect(
			repo({ "AGENTS.md": "# Agents\n", "CLAUDE.md": "# Claude\n" }),
		);
		expect(agentOf(shadowed).assets).toEqual(["CLAUDE.md"]);
		const imported = claudeCode.detect(
			repo({ "AGENTS.md": "# Agents\n", "CLAUDE.md": "@AGENTS.md\n" }),
		);
		expect(agentOf(imported).assets).toEqual(["AGENTS.md", "CLAUDE.md"]);
		expectValid(imported);
		// Nothing of Claude Code's own: no agent.
		const none = claudeCode.detect(repo({ "AGENTS.md": "# Agents\n" }));
		expect(none).toEqual({ agents: [], assets: [], problems: [] });
	});

	it("skips personal files", () => {
		const detection = claudeCode.detect(
			repo({ "CLAUDE.local.md": "mine", ".claude/settings.local.json": '{"env":{"A":"b"}}' }),
		);
		expect(detection.agents).toEqual([]);
		expect(claudeCode.wants("CLAUDE.local.md")).toBe(false);
		expect(claudeCode.wants(".claude/settings.local.json")).toBe(false);
	});

	it("reports what it cannot read and carries on", () => {
		const detection = claudeCode.detect(
			repo({
				"CLAUDE.md": "# Fine\n",
				".claude/settings.json": "{ not json",
				".mcp.json": "[]",
				".claude/skills/broken/SKILL.md": "---\nname: [unclosed\n---\nBody\n",
				".claude/skills/missing/SKILL.md": null,
				".claude/commands/bad.md": "---\ndescription: [unclosed\n---\nBody\n",
				".claude/agents/ok.md": SUBAGENT,
			}),
		);
		expectValid(detection);
		expect(detection.problems.map((problem) => problem.path).sort()).toEqual([
			".claude/commands/bad.md",
			".claude/settings.json",
			".claude/skills/broken/SKILL.md",
			".claude/skills/missing/SKILL.md",
			".mcp.json",
		]);
		expect(detection.problems.every((problem) => problem.message.length > 0)).toBe(true);
		expect(agentOf(detection).assets).toEqual(["CLAUDE.md"]);
		expect(detection.agents.map((agent) => agent.key).sort()).toEqual([
			".claude/agents/ok.md",
			"main",
		]);
	});

	it("truncates long text instead of failing", () => {
		const detection = claudeCode.detect(
			repo({
				".claude/skills/long/SKILL.md": `---\nname: ${"n".repeat(500)}\ndescription: ${"d".repeat(5000)}\n---\n`,
			}),
		);
		expectValid(detection);
		const skill = assetOf(detection, ".claude/skills/long");
		expect(skill.name).toHaveLength(200);
		expect(skill.description).toHaveLength(2000);
	});

	it("asks for the files it reads and no others", () => {
		for (const path of [
			"CLAUDE.md",
			"docs/CLAUDE.md",
			".claude/CLAUDE.md",
			".claude/settings.json",
			".mcp.json",
			".claude/skills/a/SKILL.md",
			".claude/skills/a/scripts/x.py",
			".claude/agents/a.md",
			".claude/commands/a/b.md",
			".claude/rules/a.md",
			"x/.claude-plugin/plugin.json",
		]) {
			expect(claudeCode.wants(path), path).toBe(true);
		}
		for (const path of [
			"README.md",
			".claude/agents/a.json",
			"src/.mcp.json",
			".claude/skills/.env",
			"claude.md",
		]) {
			expect(claudeCode.wants(path), path).toBe(false);
		}
	});
});
