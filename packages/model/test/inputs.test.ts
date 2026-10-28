// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { describe, expect, it } from "vitest";
import {
	agentDefinitionInput,
	type DetectedAgent,
	type DetectedAsset,
	mcpServerInput,
	repositoryPath,
	scanResult,
} from "../src";

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
	return scanResult.safeParse({
		commit: COMMIT,
		scannedAt: 1,
		agents,
		assets,
		problems: [],
		files: [],
	});
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

	it("lists each file it read once, symlinks included", () => {
		const read = (files: unknown[]) =>
			scanResult.safeParse({
				commit: COMMIT,
				scannedAt: 1,
				agents: [],
				assets: [],
				problems: [],
				files,
			});
		const file = {
			path: "AGENTS.md",
			blob: "b".repeat(40),
			size: 6,
			symlink: false,
			content: "hello\n",
		};
		const link = { path: "CLAUDE.md", blob: "c".repeat(40), size: 9, symlink: true };
		expect(read([file, link]).success).toBe(true);
		expect(read([file, { ...file, content: undefined }]).success).toBe(false);
		expect(read([{ ...file, blob: undefined }]).success).toBe(false);
		expect(read([{ ...file, path: "../AGENTS.md" }]).success).toBe(false);
	});
});

describe("mcpServerInput", () => {
	const server = (fields: Record<string, unknown>) =>
		mcpServerInput.safeParse({
			name: "acme",
			transport: "http",
			url: "https://mcp.acme.dev/mcp",
			...fields,
		});
	const refusal = (fields: Record<string, unknown>) => {
		const parsed = server(fields);
		return parsed.success ? null : parsed.error.issues[0]?.message;
	};

	it("takes an https address, or a plain one on the machine itself", () => {
		expect(server({ url: " https://MCP.acme.dev/mcp " }).data?.url).toBe(
			"https://mcp.acme.dev/mcp",
		);
		expect(server({ url: "http://localhost:8787/mcp" }).success).toBe(true);
		expect(server({ url: "http://127.0.0.1/mcp" }).success).toBe(true);
		expect(refusal({ url: "http://mcp.acme.dev/mcp" })).toBe("The URL must start with https://");
		expect(refusal({ url: "http://localhost.acme.dev/mcp" })).toBe(
			"The URL must start with https://",
		);
		expect(refusal({ url: "ftp://mcp.acme.dev" })).toBe(
			"Enter the server's full URL, starting with https://",
		);
		expect(refusal({ url: "mcp.acme.dev" })).toBe(
			"Enter the server's full URL, starting with https://",
		);
	});

	it("keeps credentials and settings out of the address", () => {
		const message = "Send credentials and settings as headers, not in the URL";
		expect(refusal({ url: "https://mcp.acme.dev/mcp?token=abc" })).toBe(message);
		expect(refusal({ url: "https://ada:secret@mcp.acme.dev/mcp" })).toBe(message);
		expect(refusal({ url: "https://mcp.acme.dev/mcp#key" })).toBe(message);
	});

	it("takes headers that name a variable, never a value", () => {
		expect(
			server({ headers: [{ name: "Authorization", value: "Bearer ${ACME_TOKEN}" }] }).success,
		).toBe(true);
		const named = "A header's value names a variable, as in Bearer ${API_TOKEN}";
		expect(refusal({ headers: [{ name: "Authorization", value: "Bearer sk-live-123" }] })).toBe(
			named,
		);
		expect(refusal({ headers: [{ name: "X-Team", value: "${team}" }] })).toBe(named);
		expect(refusal({ headers: [{ name: "X-Team", value: "${A}${B}" }] })).toBe(named);
		expect(
			refusal({
				headers: [
					{ name: "x-team", value: "${A}" },
					{ name: "X-Team", value: "${B}" },
				],
			}),
		).toBe("A header is set twice");
		expect(refusal({ headers: [{ name: "X Team", value: "${A}" }] })).toBe(
			"A header's name has no spaces or symbols",
		);
	});
});

describe("agentDefinitionInput", () => {
	it("pins each MCP server once", () => {
		const parsed = agentDefinitionInput.safeParse({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			mcpServers: [
				{ assetId: "a", version: 1 },
				{ assetId: "a", version: 2 },
			],
		});
		expect(parsed.success ? null : parsed.error.issues[0]?.message).toBe(
			"An MCP server is chosen twice",
		);
	});
});
