import { describe, expect, it } from "vitest";
import type { Detection } from "../src";
import { claudeCode } from "../src/claude-code";
import { agentOf, assetOf, expectValid, repo } from "./support";

const SKILL = "---\nname: review\ndescription: Reviews a diff.\n---\nLook at the diff.\n";

function pathsOf(detection: Detection, key: string): string[] {
	return assetOf(detection, key).files.map((file) => file.path);
}

function textOfFile(detection: Detection, key: string, path: string): string {
	const content = assetOf(detection, key).files.find((file) => file.path === path)?.content;
	if (content === undefined) throw new Error(`No text for ${path}`);
	return content;
}

describe("Claude Code plugins", () => {
	it("stores a nested plugin with its components, not just its manifest", () => {
		const detection = claudeCode.detect(
			repo({
				"plugins/lint/.claude-plugin/plugin.json": JSON.stringify({
					name: "lint-tools",
					description: "Linting helpers",
					version: "1.2.0",
					author: { name: "Example Team" },
					mcpServers: { lint: { command: "lint-mcp", env: { TOKEN: "pluginSecret" } } },
				}),
				"plugins/lint/.claude-plugin/icon.png": null,
				"plugins/lint/commands/fix.md": "Fix it\n",
				"plugins/lint/skills/review/SKILL.md": SKILL,
				"plugins/lint/hooks/hooks.json": JSON.stringify({ hooks: {} }),
				"plugins/lint/.mcp.json": JSON.stringify({ mcpServers: { docs: { command: "docs" } } }),
				"plugins/lint/scripts/run.sh": "echo hi\n",
			}),
		);
		expectValid(detection);
		expect(assetOf(detection, "plugins/lint")).toMatchObject({
			kind: "plugin",
			name: "lint-tools",
			description: "Linting helpers",
			path: "plugins/lint",
			metadata: { version: "1.2.0", author: "Example Team" },
		});
		expect(pathsOf(detection, "plugins/lint")).toEqual([
			".claude-plugin/icon.png",
			".claude-plugin/plugin.json",
			".mcp.json",
			"commands/fix.md",
			"hooks/hooks.json",
			"scripts/run.sh",
			"skills/review/SKILL.md",
		]);
		// Only configuration keeps its text; everything else is given by blob and size.
		const withText = assetOf(detection, "plugins/lint").files.filter(
			(file) => file.content !== undefined,
		);
		expect(withText.map((file) => file.path)).toEqual([
			".claude-plugin/plugin.json",
			".mcp.json",
			"hooks/hooks.json",
		]);
		expect(agentOf(detection).assets).toEqual(["plugins/lint"]);
	});

	it("redacts every configuration file of a plugin, .mcp.json included", () => {
		const detection = claudeCode.detect(
			repo({
				"p/.claude-plugin/plugin.json": JSON.stringify({
					name: "p",
					mcpServers: { a: { command: "a", env: { TOKEN: "pluginSecret" } } },
				}),
				"p/.mcp.json": JSON.stringify({
					mcpServers: {
						b: {
							command: "b",
							args: ["--token=ghp_argSecret123"],
							env: { KEY: "mcpPluginSecret" },
						},
					},
				}),
				"p/hooks/hooks.json": JSON.stringify({ hooks: {}, env: { KEY: "hooksSecret" } }),
			}),
		);
		expectValid(detection);
		const text = JSON.stringify(detection);
		for (const secret of ["pluginSecret", "mcpPluginSecret", "ghp_argSecret123", "hooksSecret"]) {
			expect(text).not.toContain(secret);
		}
		expect(textOfFile(detection, "p", ".mcp.json")).toContain('"command": "b"');
	});

	it("gives a plugin new file ids when a component changes", () => {
		const files = {
			"p/.claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
			"p/commands/a.md": "one\n",
		};
		// The blob id is Git's; the adapter passes it along, so a new id is a changed file.
		const edited = new Map(repo(files));
		const command = edited.get("p/commands/a.md");
		if (!command) throw new Error("No command");
		edited.set("p/commands/a.md", { ...command, blob: "b".repeat(40) });
		const blobs = (detection: Detection) =>
			JSON.stringify(assetOf(detection, "p").files.map((file) => [file.path, file.blob]));
		expect(blobs(claudeCode.detect(repo(files)))).toBe(blobs(claudeCode.detect(repo(files))));
		expect(blobs(claudeCode.detect(edited))).not.toBe(blobs(claudeCode.detect(repo(files))));
	});

	it("keeps one marketplace plugin out of another", () => {
		const detection = claudeCode.detect(
			repo({
				".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
				"plugins/a/.claude-plugin/plugin.json": JSON.stringify({ name: "a" }),
				"plugins/a/commands/one.md": "a\n",
				"plugins/b/.claude-plugin/plugin.json": JSON.stringify({ name: "b" }),
				"plugins/b/agents/two.md": "b\n",
				"plugins/b/vendor/c/.claude-plugin/plugin.json": JSON.stringify({ name: "c" }),
				"plugins/b/vendor/c/skills/three/SKILL.md": SKILL,
			}),
		);
		expectValid(detection);
		expect(pathsOf(detection, "plugins/a")).toEqual([
			".claude-plugin/plugin.json",
			"commands/one.md",
		]);
		expect(pathsOf(detection, "plugins/b")).toEqual([
			".claude-plugin/plugin.json",
			"agents/two.md",
		]);
		expect(pathsOf(detection, "plugins/b/vendor/c")).toEqual([
			".claude-plugin/plugin.json",
			"skills/three/SKILL.md",
		]);
		// A marketplace file alone does not make a plugin.
		expect(detection.assets.map((asset) => asset.key)).not.toContain(".claude-plugin");
	});

	it("limits a plugin at the repository root to its component locations", () => {
		const detection = claudeCode.detect(
			repo({
				".claude-plugin/plugin.json": JSON.stringify({
					name: "root-plugin",
					commands: ["./extra/cmd.md"],
					skills: ["./more-skills/", "."],
				}),
				".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
				"commands/a.md": "a\n",
				"agents/b.md": "b\n",
				"skills/s/SKILL.md": SKILL,
				"hooks/hooks.json": JSON.stringify({ hooks: {} }),
				".mcp.json": JSON.stringify({ mcpServers: { x: { command: "x" } } }),
				"extra/cmd.md": "c\n",
				"extra/other.md": "no\n",
				"more-skills/t/SKILL.md": SKILL,
				"src/index.ts": "export {};\n",
				"README.md": "# readme\n",
				"plugins/nested/.claude-plugin/plugin.json": JSON.stringify({ name: "nested" }),
				"plugins/nested/commands/n.md": "n\n",
			}),
		);
		expectValid(detection);
		expect(assetOf(detection, ".claude-plugin").name).toBe("root-plugin");
		expect(pathsOf(detection, ".claude-plugin")).toEqual([
			".claude-plugin/marketplace.json",
			".claude-plugin/plugin.json",
			".mcp.json",
			"agents/b.md",
			"commands/a.md",
			"extra/cmd.md",
			"hooks/hooks.json",
			"more-skills/t/SKILL.md",
			"skills/s/SKILL.md",
		]);
		expect(pathsOf(detection, "plugins/nested")).toEqual([
			".claude-plugin/plugin.json",
			"commands/n.md",
		]);
	});

	it("bounds the files of a plugin", () => {
		const files: Record<string, string> = {
			"p/.claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
		};
		for (let index = 0; index < 600; index += 1) files[`p/commands/c${index}.md`] = "x\n";
		const detection = claudeCode.detect(repo(files));
		expectValid(detection);
		expect(assetOf(detection, "p").files).toHaveLength(500);
		expect(detection.problems.some((problem) => problem.path === "p")).toBe(true);
	});

	it("asks for a plugin's configuration files and nothing else of it", () => {
		for (const path of [
			"plugins/a/.claude-plugin/plugin.json",
			"plugins/a/.claude-plugin/marketplace.json",
			"plugins/a/.mcp.json",
			"plugins/a/hooks/hooks.json",
			"hooks/hooks.json",
		]) {
			expect(claudeCode.wants(path), path).toBe(true);
		}
		for (const path of [
			"plugins/a/commands/x.md",
			"plugins/a/hooks/other.json",
			"plugins/a/skills/s/SKILL.md",
			"plugins/a/.env",
		]) {
			expect(claudeCode.wants(path), path).toBe(false);
		}
	});
});
