import { stringify as stringifyToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { type ApplyPlan, MERGED_FILES, planApply, type RepositoryEntry } from "../src";

type Texts = Record<string, string | null>;

/** Plans one set of files against a repository given as `path: text`. */
function plan(
	files: Record<string, string>,
	repository: Texts = {},
	options: { symlinks?: string[]; extraTree?: string[]; unread?: string[] } = {},
): ApplyPlan {
	const tree: RepositoryEntry[] = [
		...Object.keys(repository).map((path) => ({ path, symlink: false })),
		...(options.symlinks ?? []).map((path) => ({ path, symlink: true })),
		...(options.extraTree ?? []).map((path) => ({ path, symlink: false })),
	];
	const texts = new Map<string, string | null>(Object.entries(repository));
	for (const path of options.unread ?? []) texts.set(path, null);
	return planApply({
		files: Object.entries(files).map(([path, content]) => ({ path, content })),
		tree,
		texts,
	});
}

const SETUP_JSON = `${JSON.stringify({ mcpServers: { acme: { command: "npx", args: ["a"] } } }, null, 2)}\n`;
const SETUP_TOML = stringifyToml({ mcp_servers: { acme: { command: "npx", args: ["a"] } } });

function change(result: ApplyPlan, path: string): string {
	const found = result.changes.find((file) => file.path === path);
	if (!found) throw new Error(`no change for ${path}: ${JSON.stringify(result)}`);
	return found.content;
}

describe("files the setup owns", () => {
	it("writes a file that is missing", () => {
		expect(plan({ "AGENTS.md": "new\n" })).toEqual({
			changes: [{ path: "AGENTS.md", content: "new\n" }],
			unchanged: [],
			problems: [],
		});
	});

	it("leaves a file that already says the same", () => {
		const result = plan({ "AGENTS.md": "same\n" }, { "AGENTS.md": "same\n" });
		expect(result).toEqual({ changes: [], unchanged: ["AGENTS.md"], problems: [] });
	});

	it("replaces a file that says something else", () => {
		const result = plan({ "AGENTS.md": "new\n" }, { "AGENTS.md": "old\n" });
		expect(result.changes).toEqual([{ path: "AGENTS.md", content: "new\n" }]);
	});

	it("replaces a file whose text could not be read", () => {
		const unread = plan(
			{ "AGENTS.md": "new\n" },
			{},
			{ unread: ["AGENTS.md"], extraTree: ["AGENTS.md"] },
		);
		expect(unread.changes).toEqual([{ path: "AGENTS.md", content: "new\n" }]);
		const missingKey = plan({ "AGENTS.md": "new\n" }, {}, { extraTree: ["AGENTS.md"] });
		expect(missingKey.changes).toEqual([{ path: "AGENTS.md", content: "new\n" }]);
	});

	it("sorts every list by path", () => {
		const result = plan(
			{ "b.md": "1", "a.md": "2", "c.md": "3", "d.md": "4" },
			{ "d.md": "4", "c.md": "x" },
		);
		expect(result.changes.map((file) => file.path)).toEqual(["a.md", "b.md", "c.md"]);
		expect(result.unchanged).toEqual(["d.md"]);
	});
});

describe("what is not a plain file", () => {
	it("leaves a symlink alone", () => {
		const result = plan({ "CLAUDE.md": "x" }, {}, { symlinks: ["CLAUDE.md"] });
		expect(result.changes).toEqual([]);
		expect(result.problems).toEqual([
			{ path: "CLAUDE.md", message: "Is a symbolic link in the repository" },
		]);
	});

	it("does not write below a file", () => {
		const result = plan({ ".claude/skills/x/SKILL.md": "x" }, { ".claude": "oops" });
		expect(result.changes).toEqual([]);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.message).toContain(".claude");
	});

	it("does not write below a symlink", () => {
		const result = plan({ ".claude/skills/x/SKILL.md": "x" }, {}, { symlinks: [".claude/skills"] });
		expect(result.changes).toEqual([]);
		expect(result.problems[0]?.message).toContain(".claude/skills");
	});

	it("does not write over a folder", () => {
		const result = plan({ "AGENTS.md": "x" }, { "AGENTS.md/inner.txt": "y" });
		expect(result.changes).toEqual([]);
		expect(result.problems).toEqual([
			{ path: "AGENTS.md", message: "Is a folder in the repository" },
		]);
	});

	it("applies the same checks to merged files", () => {
		const result = plan({ ".mcp.json": SETUP_JSON }, {}, { symlinks: [".mcp.json"] });
		expect(result.changes).toEqual([]);
		expect(result.problems).toHaveLength(1);
	});
});

describe("merged JSON", () => {
	const paths = [".mcp.json", ".cursor/mcp.json", ".gemini/settings.json"];

	it("merges into a file with other servers and keys, keeping their order", () => {
		const existing = `${JSON.stringify(
			{ theme: "dark", mcpServers: { zeta: { command: "z" }, alpha: { command: "a" } }, last: 1 },
			null,
			2,
		)}\n`;
		for (const path of paths) {
			const result = plan({ [path]: SETUP_JSON }, { [path]: existing });
			const merged = JSON.parse(change(result, path));
			expect(Object.keys(merged)).toEqual(["theme", "mcpServers", "last"]);
			expect(Object.keys(merged.mcpServers)).toEqual(["zeta", "alpha", "acme"]);
			expect(merged.mcpServers.zeta).toEqual({ command: "z" });
			expect(change(result, path).endsWith("}\n")).toBe(true);
		}
	});

	it("replaces a server of the same name in place", () => {
		const existing = JSON.stringify({
			mcpServers: { first: { command: "1" }, acme: { command: "old" }, third: { command: "3" } },
		});
		const result = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": existing });
		const merged = JSON.parse(change(result, ".mcp.json"));
		expect(Object.keys(merged.mcpServers)).toEqual(["first", "acme", "third"]);
		expect(merged.mcpServers.acme).toEqual({ command: "npx", args: ["a"] });
	});

	it("appends mcpServers last when it is missing", () => {
		const result = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": '{"a":1,"b":2}' });
		expect(Object.keys(JSON.parse(change(result, ".mcp.json")))).toEqual(["a", "b", "mcpServers"]);
	});

	it("keeps tab and four-space indentation", () => {
		const tabs = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": '{\n\t"a": 1\n}\n' });
		expect(change(tabs, ".mcp.json")).toContain('\n\t"a": 1,\n\t"mcpServers": {\n\t\t"acme"');
		const four = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": '{\n    "a": 1\n}\n' });
		expect(change(four, ".mcp.json")).toContain(
			'\n    "a": 1,\n    "mcpServers": {\n        "acme"',
		);
		const none = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": '{"a":1}' });
		expect(change(none, ".mcp.json")).toContain('\n  "a": 1,');
	});

	it("writes LF newlines and one trailing newline", () => {
		const result = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": '{\r\n  "a": 1\r\n}\r\n' });
		const text = change(result, ".mcp.json");
		expect(text).not.toContain("\r");
		expect(text.endsWith("}\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
	});

	it("accepts a leading BOM", () => {
		const result = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": '﻿{"a":1}' });
		expect(JSON.parse(change(result, ".mcp.json")).a).toBe(1);
	});

	it("reports unchanged when the servers are equal, whatever the formatting or key order", () => {
		const existing = '{"x":1,"mcpServers":{"acme":{"args":["a"],"command":"npx"}}}';
		const result = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": existing });
		expect(result).toEqual({ changes: [], unchanged: [".mcp.json"], problems: [] });
	});

	it("reports invalid JSON, a non-object and a non-object mcpServers", () => {
		for (const existing of ['{"a":', "[]", "null", '{"mcpServers": []}', '{"mcpServers": "x"}']) {
			const result = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": existing });
			expect(result.changes).toEqual([]);
			expect(result.problems).toHaveLength(1);
		}
		const invalid = plan({ ".mcp.json": SETUP_JSON }, { ".mcp.json": "// comment\n{}" });
		expect(invalid.problems[0]?.message).toBe(
			"Is not plain JSON, so the servers could not be merged",
		);
	});

	it("writes the setup's content as it is when the file is missing", () => {
		const result = plan({ ".mcp.json": SETUP_JSON });
		expect(result.changes).toEqual([{ path: ".mcp.json", content: SETUP_JSON }]);
	});

	it("cannot merge a file it could not read", () => {
		const result = plan(
			{ ".mcp.json": SETUP_JSON },
			{},
			{ unread: [".mcp.json"], extraTree: [".mcp.json"] },
		);
		expect(result.changes).toEqual([]);
		expect(result.problems).toHaveLength(1);
	});

	it("does not crash on a setup file that is not usable", () => {
		for (const content of ["not json", "[]", "{}", '{"mcpServers": 1}']) {
			const result = plan({ ".mcp.json": content }, { ".mcp.json": "{}" });
			expect(result.changes).toEqual([]);
			expect(result.problems).toHaveLength(1);
		}
	});
});

describe("merged TOML", () => {
	const path = ".codex/config.toml";

	it("keeps comments and other tables byte for byte", () => {
		const existing = [
			"# my settings",
			'model   =  "gpt"  # keep',
			"",
			"[profiles.fast]",
			"effort = 'low'",
			"",
			"[mcp_servers.other]",
			'command = "other" # mine',
			"",
		].join("\n");
		const text = change(plan({ [path]: SETUP_TOML }, { [path]: existing }), path);
		expect(text).toBe(`${existing}\n${SETUP_TOML}`);
	});

	it("replaces a server of the same name with its subtables", () => {
		const existing = [
			"[mcp_servers.before]",
			'command = "b"',
			"",
			"[mcp_servers.acme]",
			'command = "old"',
			"",
			"[mcp_servers.acme.env]",
			'TOKEN = "x"',
			"",
			"[tail]",
			"a = 1",
			"",
		].join("\n");
		const text = change(plan({ [path]: SETUP_TOML }, { [path]: existing }), path);
		expect(text).toBe(
			`[mcp_servers.before]\ncommand = "b"\n\n[tail]\na = 1\n\n${SETUP_TOML.trimEnd()}\n`,
		);
	});

	it("handles quoted header keys, spacing and comments", () => {
		const setup = stringifyToml({ mcp_servers: { "my server": { command: "n" } } });
		const existing = [
			'[ mcp_servers . "my server" ]  # old',
			'command = "old"',
			"[mcp_servers.'my server'.env]",
			'A = "1"',
			'[[mcp_servers."my server".extra]]',
			"b = 2",
			"[mcp_servers.keep]",
			'command = "k"',
			"",
		].join("\n");
		const text = change(plan({ [path]: setup }, { [path]: existing }), path);
		expect(text).toBe(`[mcp_servers.keep]\ncommand = "k"\n\n${setup.trimEnd()}\n`);
	});

	it("handles escapes in basic quoted keys", () => {
		const setup = stringifyToml({ mcp_servers: { 'a"b': { command: "n" } } });
		const existing = '[mcp_servers."a\\"b"]\ncommand = "old"\n\n[z]\nq = 1\n';
		const text = change(plan({ [path]: setup }, { [path]: existing }), path);
		expect(text).toBe(`[z]\nq = 1\n\n${setup.trimEnd()}\n`);
	});

	it("reports unchanged when the servers are equal", () => {
		const existing = '# hi\n[mcp_servers.acme]\ncommand   = "npx"\nargs = [ "a" ]\n';
		const result = plan({ [path]: SETUP_TOML }, { [path]: existing });
		expect(result).toEqual({ changes: [], unchanged: [path], problems: [] });
	});

	it("appends to a file that has no servers yet", () => {
		const result = plan({ [path]: SETUP_TOML }, { [path]: 'model = "x"' });
		expect(change(result, path)).toBe(`model = "x"\n\n${SETUP_TOML}`);
	});

	it("does not turn an inline or dotted definition into a change", () => {
		for (const existing of [
			'mcp_servers = { acme = { command = "a" } }\n',
			'mcp_servers.acme.command = "a"\n',
			'[mcp_servers]\nacme = { command = "a" }\n',
			'[mcp_servers]\nacme.command = "a"\n',
		]) {
			const result = plan({ [path]: SETUP_TOML }, { [path]: existing });
			expect(result.changes).toEqual([]);
			expect(result.problems).toHaveLength(1);
		}
	});

	it("does not produce a corrupted change around header-like lines in strings", () => {
		const existing = [
			'note = """',
			"[mcp_servers.acme]",
			'"""',
			"[mcp_servers.acme]",
			'command = "old"',
			"",
		].join("\n");
		const result = plan({ [path]: SETUP_TOML }, { [path]: existing });
		if (result.changes.length > 0) {
			const text = change(result, path);
			expect(text).toContain('note = """\n[mcp_servers.acme]\n"""');
			expect(text).not.toContain('command = "old"');
		} else {
			expect(result.problems).toHaveLength(1);
		}
	});

	it("reports invalid TOML and a servers entry that is not a table", () => {
		for (const existing of ["= nope", 'mcp_servers = "x"\n']) {
			const result = plan({ [path]: SETUP_TOML }, { [path]: existing });
			expect(result.changes).toEqual([]);
			expect(result.problems).toHaveLength(1);
		}
	});

	it("writes the setup's content when missing and cannot merge an unreadable file", () => {
		expect(plan({ [path]: SETUP_TOML }).changes).toEqual([{ path, content: SETUP_TOML }]);
		const result = plan({ [path]: SETUP_TOML }, {}, { unread: [path], extraTree: [path] });
		expect(result.changes).toEqual([]);
		expect(result.problems).toHaveLength(1);
	});

	it("does not crash on a setup file that is not usable", () => {
		for (const content of ["= nope", 'x = "1"']) {
			const result = plan({ [path]: content }, { [path]: "" });
			expect(result.changes).toEqual([]);
			expect(result.problems).toHaveLength(1);
		}
	});
});

describe("the plan", () => {
	it("names the merged files", () => {
		expect([...MERGED_FILES].sort()).toEqual([
			".codex/config.toml",
			".cursor/mcp.json",
			".gemini/settings.json",
			".mcp.json",
		]);
	});

	it("puts every path in exactly one list", () => {
		const result = plan(
			{ "a.md": "1", "b.md": "2", "c.md": "3", ".mcp.json": SETUP_JSON },
			{ "a.md": "1", ".mcp.json": "[]" },
			{ symlinks: ["c.md"] },
		);
		const all = [
			...result.changes.map((file) => file.path),
			...result.unchanged,
			...result.problems.map((problem) => problem.path),
		].sort();
		expect(all).toEqual([".mcp.json", "a.md", "b.md", "c.md"]);
	});

	it("is the same whatever order the tree comes in", () => {
		const files = [
			{ path: "AGENTS.md", content: "x" },
			{ path: ".mcp.json", content: SETUP_JSON },
			{ path: "CLAUDE.md", content: "y" },
		];
		const tree: RepositoryEntry[] = [
			{ path: "AGENTS.md", symlink: false },
			{ path: ".mcp.json", symlink: false },
			{ path: "CLAUDE.md", symlink: true },
			{ path: "src/a.ts", symlink: false },
		];
		const texts = new Map<string, string | null>([
			["AGENTS.md", "old"],
			[".mcp.json", '{"a":1}'],
		]);
		const first = planApply({ files, tree, texts });
		const second = planApply({ files: [...files].reverse(), tree: [...tree].reverse(), texts });
		expect(second).toEqual(first);
	});
});
