import { describe, expect, it } from "vitest";
import { groupSetupFolders, readSetupFolder, withAddresses, writeAssets } from "../src";

const SKILL = "---\nname: review\ndescription: Reviews a change\n---\nLook closely.\n";
// biome-ignore lint/suspicious/noTemplateCurlyInString: the reference a server file holds
const KEY = "Bearer ${ACME_KEY}";
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
			addresses: [],
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

	it("group by folder as a bundler lists them, leaving out files outside any folder", () => {
		const grouped = groupSetupFolders({
			"../../setups/review/setup.json": "{}",
			"../../setups/baseline/skills/review/SKILL.md": SKILL,
			"../../setups/baseline/setup.json": "{}",
			"../../setups/README.md": "Not a setup.\n",
		});
		expect([...grouped.keys()]).toEqual(["baseline", "review"]);
		expect(grouped.get("baseline")).toEqual(
			new Map([
				["skills/review/SKILL.md", SKILL],
				["setup.json", "{}"],
			]),
		);
	});

	it("ask for a server's address when it differs from one install to the next", () => {
		const asking = {
			...BASELINE,
			assets: [BASELINE.assets[0], { ...BASELINE.assets[2], askUrl: "Your Acme's MCP address" }],
		};
		const SECRET_SERVER = `${JSON.stringify(
			{
				headers: { Authorization: KEY },
				type: "http",
				url: "https://acme.example.com/mcp",
			},
			null,
			2,
		)}\n`;
		const read = readSetupFolder(folder(asking, { ...FILES, "servers/acme.json": SECRET_SERVER }));
		if (!read.ok) throw new Error(read.problems.join("\n"));
		expect(read.setup.addresses).toEqual([
			{ server: "acme", label: "Your Acme's MCP address", example: "https://acme.example.com/mcp" },
		]);

		const answered = withAddresses(read.setup, { acme: " https://mail.acme.dev/mcp " });
		if (!answered.ok) throw new Error(answered.problems.join("\n"));
		expect(answered.setup.addresses).toEqual([]);
		const server = answered.setup.assets.find((asset) => asset.kind === "mcp-server");
		expect(JSON.parse(server?.files[0]?.content ?? "")).toEqual({
			headers: { Authorization: KEY },
			type: "http",
			url: "https://mail.acme.dev/mcp",
		});
		const mcp = writeAssets(answered.setup.assets, ["claude-code"]).files.find(
			(file) => file.path === ".mcp.json",
		);
		expect(JSON.parse(mcp?.content ?? "").mcpServers.acme).toEqual({
			headers: { Authorization: KEY },
			type: "http",
			url: "https://mail.acme.dev/mcp",
		});
		// The folder's own reading is left as it was.
		expect(read.setup.assets[1]?.files[0]?.content).toBe(SECRET_SERVER);

		for (const [given, problem] of [
			[{}, "acme: give its address (Your Acme's MCP address)"],
			[{ acme: "  " }, "acme: give its address (Your Acme's MCP address)"],
			[{ acme: "http://mail.acme.dev/mcp" }, "acme: The URL must start with https://"],
			[
				{ acme: "https://key@mail.acme.dev/mcp" },
				"acme: Send credentials and settings as headers, not in the URL",
			],
		] as const) {
			expect(withAddresses(read.setup, given), JSON.stringify(given)).toEqual({
				ok: false,
				problems: [problem],
			});
		}
		expect(
			withAddresses(read.setup, { acme: "https://mail.acme.dev/mcp", other: "https://x.dev/mcp" }),
		).toEqual({ ok: false, problems: ["Baseline asks for no address for other"] });
		// A setup that asks for nothing takes nothing.
		const plain = readSetupFolder(folder(BASELINE, FILES));
		if (!plain.ok) throw new Error(plain.problems.join("\n"));
		expect(withAddresses(plain.setup, {})).toEqual({ ok: true, setup: plain.setup });
	});

	it("ask for an address only of a server with a URL in a JSON file", () => {
		const problems = (asset: Record<string, unknown>, files: Record<string, string>) => {
			const result = readSetupFolder(folder({ ...BASELINE, assets: [asset] }, files));
			return result.ok ? [] : result.problems;
		};
		expect(
			problems({ kind: "skill", name: "review", path: "skills/review", askUrl: "Where?" }, FILES),
		).toEqual(["setup.json at assets.0.askUrl: Only an MCP server has an address to ask for"]);
		const server = {
			kind: "mcp-server",
			name: "acme",
			path: "servers/acme.json",
			askUrl: "Where?",
		};
		expect(
			problems(server, {
				"servers/acme.json": JSON.stringify({ command: "acme", args: ["serve"] }),
			}),
		).toEqual(["acme: askUrl is for a server reached over the network, not a local command"]);
		expect(
			problems(
				{ ...server, path: "servers/acme.toml" },
				{ "servers/acme.toml": 'url = "https://acme.example.com/mcp"\n' },
			),
		).toEqual(["acme: askUrl needs the server in a JSON file with a url"]);
		expect(
			problems(server, { "servers/acme.json": JSON.stringify({ url: "http://acme.example.com" }) }),
		).toEqual(["acme: its example address: The URL must start with https://"]);
		// Gemini's httpUrl is the address its file is read for, so the given one would go unread.
		const both = { httpUrl: "https://real.example.com/mcp", url: "https://acme.example.com/mcp" };
		expect(problems(server, { "servers/acme.json": JSON.stringify(both) })).toEqual([
			"acme: askUrl needs the server in a JSON file with a url",
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
