import { expect, it } from "vitest";
import { repositoryPathOf } from "../src";

it("places a file asset's file at the asset's path", () => {
	const files = [{ path: "CLAUDE.md" }];
	expect(
		repositoryPathOf({ kind: "instructions", path: "app/CLAUDE.md" }, files, { path: "CLAUDE.md" }),
	).toBe("app/CLAUDE.md");
	// Part of a file, such as one MCP server, is stored under the file's name.
	expect(
		repositoryPathOf({ kind: "mcp-server", path: ".mcp.json" }, [{ path: ".mcp.json" }], {
			path: ".mcp.json",
		}),
	).toBe(".mcp.json");
});

it("places a folder asset's files under the asset's path", () => {
	const files = [{ path: "SKILL.md" }, { path: "scripts/run.sh" }];
	expect(
		repositoryPathOf({ kind: "skill", path: ".claude/skills/review" }, files, {
			path: "scripts/run.sh",
		}),
	).toBe(".claude/skills/review/scripts/run.sh");
	expect(
		repositoryPathOf({ kind: "skill", path: ".claude/skills/review" }, [{ path: "SKILL.md" }], {
			path: "SKILL.md",
		}),
	).toBe(".claude/skills/review/SKILL.md");
});

it("places a repository-root plugin's files from the root", () => {
	const files = [{ path: ".claude-plugin/plugin.json" }, { path: "commands/fix.md" }];
	const root = { kind: "plugin", path: ".claude-plugin" } as const;
	expect(repositoryPathOf(root, files, { path: "commands/fix.md" })).toBe("commands/fix.md");
	expect(
		repositoryPathOf({ kind: "plugin", path: "plugins/lint" }, files, { path: "commands/fix.md" }),
	).toBe("plugins/lint/commands/fix.md");
});
