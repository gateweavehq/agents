import { describe, expect, it } from "vitest";
import { type DetectedAgent, type DetectedAsset, repositoryPath, scanResult } from "../src";

const COMMIT = "a".repeat(40);

function asset(overrides: Partial<DetectedAsset> = {}): DetectedAsset {
	return {
		kind: "instructions",
		key: "CLAUDE.md",
		name: "CLAUDE.md",
		description: null,
		path: "CLAUDE.md",
		files: [{ path: "CLAUDE.md", content: "# Rules\n" }],
		metadata: {},
		...overrides,
	};
}

function agent(overrides: Partial<DetectedAgent> = {}): DetectedAgent {
	return {
		runtime: "claude-code",
		key: "main",
		name: "Claude Code",
		description: null,
		model: null,
		path: null,
		metadata: {},
		assets: ["CLAUDE.md"],
		...overrides,
	};
}

function scan(agents: DetectedAgent[], assets: DetectedAsset[]) {
	return scanResult.safeParse({ commit: COMMIT, scannedAt: 1, agents, assets, problems: [] });
}

describe("repositoryPath", () => {
	it("accepts relative paths and refuses anything that leaves the repository", () => {
		for (const path of ["CLAUDE.md", ".claude/skills/review/SKILL.md", ".mcp.json"]) {
			expect(repositoryPath.safeParse(path).success, path).toBe(true);
		}
		for (const path of [
			"",
			"/etc/passwd",
			"../secrets",
			"a/../../b",
			"a//b",
			"a/",
			"./a",
			"a\\b",
		]) {
			expect(repositoryPath.safeParse(path).success, path).toBe(false);
		}
	});
});

describe("scanResult", () => {
	it("accepts agents that read assets from the same scan", () => {
		expect(scan([agent()], [asset()]).success).toBe(true);
	});

	it("refuses an agent that reads an asset the scan does not have", () => {
		const result = scan([agent({ assets: ["AGENTS.md"] })], [asset()]);
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["agents", 0, "assets", 0]);
	});

	it("refuses two assets, two agents or two files with the same key", () => {
		expect(scan([], [asset(), asset()]).success).toBe(false);
		expect(scan([agent(), agent()], [asset()]).success).toBe(false);
		const file = { path: "SKILL.md", content: "x" };
		expect(scan([], [asset({ kind: "skill", files: [file, file] })]).success).toBe(false);
		// The same key under another runtime is another agent.
		expect(scan([agent(), agent({ runtime: "codex" })], [asset()]).success).toBe(true);
	});

	it("takes a file by its blob and size when its content is left out", () => {
		const blob = "b".repeat(40);
		const binary = { path: "logo.png", blob, size: 1200 };
		expect(scan([], [asset({ files: [binary] })]).success).toBe(true);
		expect(scan([], [asset({ files: [{ path: "logo.png", blob }] })]).success).toBe(false);
	});
});
