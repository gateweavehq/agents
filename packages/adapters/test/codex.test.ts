import { describe, expect, it } from "vitest";
import { codex } from "../src/codex";
import { agentOf, assetOf, expectValid, repo, textOf } from "./support";

const CONFIG = `model = "gpt-5-codex"
approval_policy = "on-request"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["LOCAL_TOKEN"]

[mcp_servers.context7.env]
CONTEXT7_API_KEY = "ctx7sk-tomlSecret"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
`;

describe("codex adapter", () => {
	it("finds an agent from AGENTS.md alone, and nothing else", () => {
		const detection = codex.detect(repo({ "AGENTS.md": "# Agents\n" }));
		expectValid(detection);
		expect(detection.agents).toEqual([
			{
				runtime: "codex",
				key: "main",
				name: "Codex",
				description: null,
				model: null,
				path: null,
				metadata: {},
				assets: ["AGENTS.md"],
			},
		]);
		expect(detection.assets.map((asset) => asset.key)).toEqual(["AGENTS.md"]);
	});

	it("reads nested AGENTS.md and override files", () => {
		const detection = codex.detect(
			repo({
				"AGENTS.md": "root",
				"services/api/AGENTS.md": "api",
				"services/api/AGENTS.override.md": "local",
			}),
		);
		expectValid(detection);
		expect(agentOf(detection).assets).toEqual([
			"AGENTS.md",
			"services/api/AGENTS.md",
			"services/api/AGENTS.override.md",
		]);
		expect(assetOf(detection, "services/api/AGENTS.md")).toMatchObject({
			kind: "instructions",
			path: "services/api/AGENTS.md",
			files: [{ path: "AGENTS.md", content: "api" }],
		});
	});

	it("reads .codex/config.toml as settings and MCP servers, without secrets", () => {
		const detection = codex.detect(repo({ ".codex/config.toml": CONFIG }));
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		const main = agentOf(detection);
		expect(main.model).toBe("gpt-5-codex");
		expect(main.assets).toEqual([
			".codex/config.toml",
			".codex/config.toml#context7",
			".codex/config.toml#figma",
		]);
		expect(assetOf(detection, ".codex/config.toml")).toMatchObject({
			kind: "settings",
			metadata: {
				model: "gpt-5-codex",
				approval_policy: "on-request",
				mcp_servers: ["context7", "figma"],
			},
		});
		expect(assetOf(detection, ".codex/config.toml#context7")).toMatchObject({
			kind: "mcp-server",
			metadata: {
				type: "stdio",
				command: "npx",
				args: ["-y", "@upstash/context7-mcp"],
				env_vars: ["LOCAL_TOKEN"],
				env: ["CONTEXT7_API_KEY"],
			},
		});
		expect(assetOf(detection, ".codex/config.toml#figma").metadata).toEqual({
			url: "https://mcp.figma.com/mcp",
			bearer_token_env_var: "FIGMA_OAUTH_TOKEN",
			headers: ["X-Figma-Region"],
		});
		expect(JSON.stringify(detection)).not.toContain("ctx7sk-tomlSecret");
		expect(textOf(detection, ".codex/config.toml#context7")).toContain(
			'CONTEXT7_API_KEY = "<redacted>"',
		);
		expect(textOf(detection, ".codex/config.toml")).not.toContain("tomlSecret");
	});

	it("reads skills from .agents/skills", () => {
		const detection = codex.detect(
			repo({
				".agents/skills/lint/SKILL.md": "---\nname: lint\ndescription: Run the linter.\n---\n",
				".agents/skills/lint/agents/openai.yaml": "interface:\n  display_name: Lint\n",
				".agents/skills/lint/assets/logo.png": null,
			}),
		);
		expectValid(detection);
		expect(agentOf(detection).assets).toEqual([".agents/skills/lint"]);
		expect(assetOf(detection, ".agents/skills/lint").files.map((file) => file.path)).toEqual([
			"SKILL.md",
			"agents/openai.yaml",
			"assets/logo.png",
		]);
	});

	it("reports broken TOML and keeps going", () => {
		const detection = codex.detect(
			repo({ "AGENTS.md": "# Agents\n", ".codex/config.toml": "model = " }),
		);
		expectValid(detection);
		expect(detection.problems).toHaveLength(1);
		expect(detection.problems[0]?.path).toBe(".codex/config.toml");
		expect(agentOf(detection).assets).toEqual(["AGENTS.md"]);
	});

	it("reports an AGENTS.md whose text was not downloaded", () => {
		const detection = codex.detect(repo({ "AGENTS.md": null }));
		expectValid(detection);
		expect(detection.agents).toEqual([]);
		expect(detection.problems.map((problem) => problem.path)).toEqual(["AGENTS.md"]);
	});

	it("asks for the files it reads and no others", () => {
		for (const path of [
			"AGENTS.md",
			"a/b/AGENTS.md",
			"AGENTS.override.md",
			".codex/config.toml",
			".agents/skills/x/SKILL.md",
		]) {
			expect(codex.wants(path), path).toBe(true);
		}
		for (const path of [
			"agents.md",
			"config.toml",
			".codex/rules/default.rules",
			"AGENTS.md.bak",
		]) {
			expect(codex.wants(path), path).toBe(false);
		}
	});
});
