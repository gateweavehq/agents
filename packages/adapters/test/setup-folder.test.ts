import { describe, expect, it } from "vitest";
import { readSetupFolder, writeAssets } from "../src";

const SKILL = "---\nname: review\ndescription: Reviews a change\n---\nLook closely.\n";
const SERVER = `${JSON.stringify({ type: "http", url: "https://mcp.acme.dev/mcp" }, null, 2)}\n`;

function folder(manifest: unknown, files: Record<string, string> = {}) {
	return new Map([["setup.json", JSON.stringify(manifest)], ...Object.entries(files)]);
}

const BASELINE = {
	name: "Baseline",
	description: "Rules, a review skill and a server",
	runtimes: ["codex", "claude-code"],
	assets: [
		{ kind: "instructions", name: "AGENTS.md", path: "AGENTS.md" },
		{ kind: "skill", name: "review", path: "skills/review" },
		{ kind: "mcp-server", name: "acme", path: "servers/acme.json" },
	],
};
const FILES = {
	"AGENTS.md": "Be brief.\n",
	"skills/review/SKILL.md": SKILL,
	"skills/review/scripts/check.sh": "echo ok\n",
	"servers/acme.json": SERVER,
	"README.md": "Not an asset.\n",
};

describe("setup folders", () => {
	it("read into assets the writers take, with runtimes in their usual order", () => {
		const result = readSetupFolder(folder(BASELINE, FILES));
		if (!result.ok) throw new Error(result.problems.join("\n"));
		expect(result.setup).toEqual({
			name: "Baseline",
			description: "Rules, a review skill and a server",
			runtimes: ["claude-code", "codex"],
			assets: [
				{
					kind: "instructions",
					name: "AGENTS.md",
					description: null,
					files: [{ path: "AGENTS.md", content: "Be brief.\n" }],
					metadata: {},
				},
				{
					kind: "skill",
					name: "review",
					description: null,
					files: [
						{ path: "SKILL.md", content: SKILL },
						{ path: "scripts/check.sh", content: "echo ok\n" },
					],
					metadata: {},
				},
				{
					kind: "mcp-server",
					name: "acme",
					description: null,
					files: [{ path: "acme.json", content: SERVER }],
					metadata: {},
				},
			],
		});
		const written = writeAssets(result.setup.assets, result.setup.runtimes);
		expect(written.problems).toEqual([]);
		expect(written.files.map((file) => file.path)).toEqual([
			".agents/skills/review/SKILL.md",
			".agents/skills/review/scripts/check.sh",
			".claude/skills/review/SKILL.md",
			".claude/skills/review/scripts/check.sh",
			".codex/config.toml",
			".mcp.json",
			"AGENTS.md",
			"CLAUDE.md",
		]);
	});

	it("say what is wrong with setup.json", () => {
		expect(readSetupFolder(new Map())).toEqual({ ok: false, problems: ["There is no setup.json"] });
		const broken = readSetupFolder(new Map([["setup.json", "{ name"]]));
		expect(broken.ok ? [] : broken.problems[0]).toMatch(/^setup.json is not valid JSON: /);

		const invalid = readSetupFolder(
			folder({
				name: "",
				runtimes: [],
				assets: [{ kind: "spell", name: "x", path: "../x" }],
			}),
		);
		expect(invalid.ok ? [] : invalid.problems).toEqual([
			expect.stringMatching(/^setup.json at name: /),
			"setup.json at runtimes: Choose at least one coding agent",
			expect.stringMatching(/^setup.json at assets.0.kind: /),
			expect.stringMatching(/^setup.json at assets.0.path: Must be a relative path/),
		]);

		const twice = { ...BASELINE, assets: [BASELINE.assets[0], BASELINE.assets[0]] };
		const repeated = readSetupFolder(folder(twice, FILES));
		expect(repeated.ok ? [] : repeated.problems).toEqual([
			"setup.json at assets.1.name: Another instructions is named AGENTS.md",
		]);
	});

	it("say which asset has no files", () => {
		const { "skills/review/SKILL.md": _, "skills/review/scripts/check.sh": __, ...rest } = FILES;
		const result = readSetupFolder(folder(BASELINE, rest));
		expect(result).toEqual({
			ok: false,
			problems: ["review: there is no file or folder at skills/review"],
		});
	});
});
