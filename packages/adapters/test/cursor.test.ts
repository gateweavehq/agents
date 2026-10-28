import { describe, expect, it } from "vitest";
import { cursor } from "../src/cursor";
import { agentOf, assetOf, expectValid, repo } from "./support";

const RULE = `---
description: Conventions for React components
globs: src/components/**/*.tsx
alwaysApply: false
---
Use function components.
`;

describe("cursor adapter", () => {
	it("reads project rules with their front matter", () => {
		const detection = cursor.detect(
			repo({
				".cursor/rules/frontend/components.mdc": RULE,
				".cursor/rules/always.mdc": "---\nalwaysApply: true\n---\nBe brief.\n",
				".cursor/rules/ignored.md": "Cursor ignores plain Markdown here.",
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(assetOf(detection, ".cursor/rules/frontend/components.mdc")).toMatchObject({
			kind: "instructions",
			name: "frontend/components",
			description: "Conventions for React components",
			files: [{ path: "components.mdc", content: RULE }],
			metadata: { globs: ["src/components/**/*.tsx"], alwaysApply: false },
		});
		expect(assetOf(detection, ".cursor/rules/always.mdc")).toMatchObject({
			description: null,
			metadata: { alwaysApply: true },
		});
		expect(detection.assets.map((asset) => asset.key)).not.toContain(".cursor/rules/ignored.md");
		expect(agentOf(detection)).toMatchObject({
			runtime: "cursor",
			name: "Cursor",
			model: null,
			path: null,
		});
	});

	it("accepts the unquoted globs Cursor itself writes", () => {
		const detection = cursor.detect(
			repo({
				".cursor/rules/ts.mdc":
					"---\ndescription: TS\nglobs: *.ts, *.tsx\nalwaysApply: false\n---\nBody\n",
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(assetOf(detection, ".cursor/rules/ts.mdc").metadata).toEqual({
			globs: ["*.ts", "*.tsx"],
			alwaysApply: false,
		});
	});

	it("reads the legacy .cursorrules file", () => {
		const detection = cursor.detect(repo({ ".cursorrules": "Always use tabs.\n" }));
		expectValid(detection);
		expect(assetOf(detection, ".cursorrules")).toMatchObject({
			kind: "instructions",
			metadata: { legacy: true },
			files: [{ path: ".cursorrules", content: "Always use tabs.\n" }],
		});
	});

	it("reads .cursor/mcp.json without secrets", () => {
		const detection = cursor.detect(
			repo({
				".cursor/mcp.json": JSON.stringify({
					mcpServers: {
						local: { command: "node", args: ["server.js"], env: { API_KEY: "cursorEnvSecret" } },
						remote: {
							url: "https://api.example.com/mcp",
							headers: { Authorization: "Bearer cursorHeaderSecret" },
							auth: {
								CLIENT_ID: "client-1",
								CLIENT_SECRET: "cursorClientSecret",
								scopes: ["read"],
							},
						},
					},
				}),
			}),
		);
		expectValid(detection);
		expect(assetOf(detection, ".cursor/mcp.json#local")).toMatchObject({
			kind: "mcp-server",
			path: ".cursor/mcp.json",
			files: [{ path: "mcp.json" }],
			metadata: { type: "stdio", command: "node", args: ["server.js"], env: ["API_KEY"] },
		});
		expect(assetOf(detection, ".cursor/mcp.json#remote").metadata).toEqual({
			url: "https://api.example.com/mcp",
			headers: ["Authorization"],
		});
		const everything = JSON.stringify(detection);
		for (const secret of ["cursorEnvSecret", "cursorHeaderSecret", "cursorClientSecret"]) {
			expect(everything).not.toContain(secret);
		}
		expect(everything).toContain("client-1");
	});

	it("links AGENTS.md and shared skills once Cursor is in the repository", () => {
		const files = {
			"AGENTS.md": "# Agents\n",
			"apps/web/AGENTS.md": "# Web\n",
			".claude/skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\n",
			".agents/skills/b/SKILL.md": "---\nname: b\ndescription: B\n---\n",
			".cursor/skills/c/SKILL.md": "---\nname: c\ndescription: C\n---\n",
		};
		// Other agents' files alone do not make a Cursor agent.
		const { ".cursor/skills/c/SKILL.md": _own, ...others } = files;
		expect(cursor.detect(repo(others)).agents).toEqual([]);
		const withRule = cursor.detect(
			repo({ ...files, ".cursor/rules/r.mdc": "---\nalwaysApply: true\n---\n" }),
		);
		expectValid(withRule);
		expect(agentOf(withRule).assets).toEqual([
			".agents/skills/b",
			".claude/skills/a",
			".cursor/rules/r.mdc",
			".cursor/skills/c",
			"AGENTS.md",
			"apps/web/AGENTS.md",
		]);
	});

	it("finds no agent in a repository that only has AGENTS.md", () => {
		expect(cursor.detect(repo({ "AGENTS.md": "# Agents\n" }))).toEqual({
			agents: [],
			assets: [],
			problems: [],
		});
	});

	it("reports invalid MCP JSON and rules without text", () => {
		const detection = cursor.detect(
			repo({
				".cursor/mcp.json": "{",
				".cursor/rules/a.mdc": null,
				".cursor/rules/b.mdc": "---\nalwaysApply: true\n---\n",
			}),
		);
		expectValid(detection);
		expect(detection.problems.map((problem) => problem.path)).toEqual([
			".cursor/rules/a.mdc",
			".cursor/mcp.json",
		]);
		expect(agentOf(detection).assets).toEqual([".cursor/rules/b.mdc"]);
	});

	it("asks for the files it reads and no others", () => {
		for (const path of [
			".cursor/rules/a.mdc",
			".cursor/rules/x/y.mdc",
			".cursorrules",
			".cursor/mcp.json",
			".cursor/skills/s/SKILL.md",
		]) {
			expect(cursor.wants(path), path).toBe(true);
		}
		for (const path of [
			".cursor/rules/a.md",
			"cursorrules",
			".cursor/settings.json",
			"src/.cursor/mcp.json",
		]) {
			expect(cursor.wants(path), path).toBe(false);
		}
	});
});
