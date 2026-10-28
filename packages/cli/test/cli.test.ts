import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readSetupFolder, writeAssets } from "@gateweave/agents-adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli";
import { READY_MADE } from "../src/setups";

const SKILL = "---\nname: review\ndescription: Reviews a change\n---\nLook closely.\n";
const SETUP = {
	"setup.json": JSON.stringify({
		name: "Baseline",
		runtimes: ["claude-code", "codex"],
		assets: [
			{ kind: "instructions", name: "AGENTS.md", path: "AGENTS.md" },
			{ kind: "skill", name: "review", path: "skills/review" },
			{ kind: "mcp-server", name: "acme", path: "servers/acme.json" },
		],
	}),
	"AGENTS.md": "Be brief.\n",
	"skills/review/SKILL.md": SKILL,
	"servers/acme.json": JSON.stringify({ type: "http", url: "https://mcp.acme.dev/mcp" }),
};
const WRITTEN = [
	".agents/skills/review/SKILL.md",
	".claude/skills/review/SKILL.md",
	".codex/config.toml",
	".mcp.json",
	"AGENTS.md",
	"CLAUDE.md",
];

let base: string;
let repo: string;
let setup: string;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "gateweave-agents-"));
	repo = join(base, "repo");
	setup = join(base, "setup");
	await mkdir(repo);
	await put(setup, SETUP);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

async function put(root: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
}

async function cli(...args: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await run(args, {
		cwd: base,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("apply", () => {
	it("writes every file the setup writes, after which check passes", async () => {
		const before = await cli("check", "./setup", "--dir", "repo");
		expect(before.code).toBe(1);
		for (const path of WRITTEN) expect(before.out).toContain(`missing  ${path}`);
		expect(before.out).toContain("6 of 6 files differ from the setup");

		const applied = await cli("apply", "./setup", "--dir", "repo");
		expect(applied).toMatchObject({ code: 0, err: "" });
		expect(applied.out).toContain("6 files written, 0 already up to date.");
		expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("Be brief.\n");
		expect(await readFile(join(repo, ".claude/skills/review/SKILL.md"), "utf8")).toBe(SKILL);

		const after = await cli("check", "./setup", "--dir", "repo");
		expect(after).toMatchObject({ code: 0, err: "" });
		expect(after.out).toContain("All 6 files hold what it writes.");

		await writeFile(join(repo, "AGENTS.md"), "Be thorough.\n");
		const edited = await cli("check", "./setup", "--dir", "repo");
		expect(edited.code).toBe(1);
		expect(edited.out).toContain("differs  AGENTS.md");
		expect(edited.out).toContain("1 of 6 files differ from the setup");
	});

	it("merges its servers into MCP configuration the repository already has", async () => {
		const other = { command: "npx", args: ["-y", "other-mcp"] };
		await put(repo, { ".mcp.json": `${JSON.stringify({ mcpServers: { other } }, null, "\t")}\n` });
		expect((await cli("apply", "./setup", "--dir", "repo")).code).toBe(0);
		const merged = JSON.parse(await readFile(join(repo, ".mcp.json"), "utf8"));
		expect(merged.mcpServers).toEqual({
			other,
			acme: { type: "http", url: "https://mcp.acme.dev/mcp" },
		});
		expect((await cli("check", "./setup", "--dir", "repo")).code).toBe(0);
	});

	it("takes a checkout with CRLF line endings as holding the same text", async () => {
		expect((await cli("apply", "./setup", "--dir", "repo")).code).toBe(0);
		await writeFile(join(repo, "AGENTS.md"), "Be brief.\r\n");
		await writeFile(join(setup, "AGENTS.md"), "Be brief.\r\n");
		expect((await cli("check", "./setup", "--dir", "repo")).code).toBe(0);
	});

	it("writes nothing on a dry run", async () => {
		const dry = await cli("apply", "./setup", "--dir", "repo", "--dry-run");
		expect(dry.code).toBe(0);
		expect(dry.out).toContain("would write  AGENTS.md");
		expect(dry.out).toContain("6 files to write, 0 already up to date.");
		expect((await cli("check", "./setup", "--dir", "repo")).code).toBe(1);
	});

	it("leaves a symlink alone and says so, without failing a check", async (context) => {
		await put(repo, { "AGENTS.md": "Be brief.\n" });
		try {
			await symlink("AGENTS.md", join(repo, "CLAUDE.md"));
		} catch {
			context.skip("This system does not let the tests create symlinks");
		}
		const applied = await cli("apply", "./setup", "--dir", "repo");
		expect(applied.code).toBe(0);
		expect(applied.out).toContain("4 files written, 1 already up to date.");
		expect(applied.err).toBe("Left alone:\n  CLAUDE.md: Is a symbolic link in the repository");

		const checked = await cli("check", "./setup", "--dir", "repo");
		expect(checked.code).toBe(0);
		expect(checked.err).toContain("CLAUDE.md: Is a symbolic link in the repository");
	});

	it("never writes below a file where the setup needs a folder", async () => {
		await put(repo, { ".claude": "not a folder\n" });
		const applied = await cli("apply", "./setup", "--dir", "repo");
		expect(applied.code).toBe(0);
		expect(applied.err).toContain(
			".claude/skills/review/SKILL.md: .claude is a file in the repository",
		);
		expect(await readFile(join(repo, ".claude"), "utf8")).toBe("not a folder\n");
	});
});

describe("problems", () => {
	it("stop with exit code 2 and say what is wrong", async () => {
		const unknown = await cli("apply", "nothing-by-this-name");
		expect(unknown.code).toBe(2);
		expect(unknown.err).toContain(
			"There is no folder or ready-made setup called nothing-by-this-name",
		);

		await writeFile(join(setup, "setup.json"), "{ name");
		const broken = await cli("check", "./setup");
		expect(broken.code).toBe(2);
		expect(broken.err).toMatch(/setup.json is not valid JSON/);

		expect((await cli("apply")).code).toBe(2);
		expect((await cli("check", "./setup", "--dry-run")).code).toBe(2);
		expect((await cli("deploy", "./setup")).code).toBe(2);
		expect((await cli("apply", "./setup", "--force")).code).toBe(2);
		expect(await cli("--version")).toMatchObject({
			code: 0,
			out: expect.stringMatching(/^\d+\.\d+\.\d+$/),
		});
		expect((await cli("--help")).out).toContain("Usage: gateweave-agents");
	});
});

describe("ready-made setups", () => {
	it("are listed and each one reads and writes cleanly", async () => {
		const listed = await cli("list");
		expect(listed.code).toBe(0);
		expect(listed.out.split("\n").filter(Boolean)).toEqual([...READY_MADE.keys()]);
		for (const [name, files] of READY_MADE) {
			const result = readSetupFolder(files);
			if (!result.ok) throw new Error(`${name}: ${result.problems.join("; ")}`);
			expect(writeAssets(result.setup.assets, result.setup.runtimes).problems, name).toEqual([]);
		}
	});
});
