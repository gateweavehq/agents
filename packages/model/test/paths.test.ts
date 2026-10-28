import { expect, it } from "vitest";
import { repositoryPathOf } from "../src";

it("places a file asset's file at the asset's path", () => {
	const files = [{ path: "CLAUDE.md" }];
	expect(repositoryPathOf({ path: "app/CLAUDE.md" }, files, { path: "CLAUDE.md" })).toBe(
		"app/CLAUDE.md",
	);
	// Part of a file, such as one MCP server, is stored under the file's name.
	expect(
		repositoryPathOf({ path: ".mcp.json" }, [{ path: ".mcp.json" }], { path: ".mcp.json" }),
	).toBe(".mcp.json");
});

it("places a folder asset's files under the asset's path", () => {
	const files = [{ path: "SKILL.md" }, { path: "scripts/run.sh" }];
	expect(
		repositoryPathOf({ path: ".claude/skills/review" }, files, { path: "scripts/run.sh" }),
	).toBe(".claude/skills/review/scripts/run.sh");
	expect(
		repositoryPathOf({ path: ".claude/skills/review" }, [{ path: "SKILL.md" }], {
			path: "SKILL.md",
		}),
	).toBe(".claude/skills/review/SKILL.md");
});
