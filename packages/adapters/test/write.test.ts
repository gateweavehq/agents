import {
	type AssetKind,
	REPOSITORY_RUNTIMES,
	type RepositoryRuntime,
} from "@gateweave/agents-model";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { type AssetToWrite, detect, writeAssets } from "../src";
import { repo } from "./support";

function asset(
	kind: AssetKind,
	name: string,
	files: Record<string, string | null>,
	extra: Partial<Pick<AssetToWrite, "description" | "metadata">> = {},
): AssetToWrite {
	return {
		kind,
		name,
		description: extra.description ?? null,
		files: Object.entries(files).map(([path, content]) => ({ path, content })),
		metadata: extra.metadata ?? {},
	};
}

function instructions(name: string, text: string | null): AssetToWrite {
	return asset("instructions", name, { [name.split("/").pop() ?? name]: text });
}

/** An MCP server as the registry stores it: redacted, in the file format it came from. */
function server(name: string, config: object, file = ".mcp.json"): AssetToWrite {
	const content = file.endsWith(".toml")
		? stringifyToml(config as Record<string, unknown>)
		: `${JSON.stringify(config, null, 2)}\n`;
	return asset("mcp-server", name, { [file]: content });
}

const STDIO = {
	command: "npx",
	args: ["-y", "@acme/mcp"],
	env: { ACME_TOKEN: "<redacted>" },
};
const HTTP = {
	type: "http",
	url: "https://mcp.acme.dev/mcp",
	headers: { Authorization: "<redacted>", "X-Team": "<redacted>" },
};

/** A variable reference as the formats write it; spelled out here to keep lint quiet. */
function ref(name: string, prefix = ""): string {
	return `${prefix}$\{${name}}`;
}

function write(assets: AssetToWrite[], ...runtimes: RepositoryRuntime[]) {
	return writeAssets(assets, runtimes);
}

function fileMap(result: ReturnType<typeof write>): Record<string, string> {
	return Object.fromEntries(result.files.map((file) => [file.path, file.content]));
}

function json(result: ReturnType<typeof write>, path: string): unknown {
	return JSON.parse(fileMap(result)[path] ?? "null");
}

describe("instructions", () => {
	const guide = instructions("AGENTS.md", "# Guide\n\nRun tests.\n");

	it("writes the file each agent reads", () => {
		expect(fileMap(write([guide], "codex"))).toEqual({ "AGENTS.md": "# Guide\n\nRun tests.\n" });
		expect(fileMap(write([guide], "cursor"))).toEqual({ "AGENTS.md": "# Guide\n\nRun tests.\n" });
		expect(fileMap(write([guide], "claude-code"))).toEqual({
			"CLAUDE.md": "# Guide\n\nRun tests.\n",
		});
		expect(fileMap(write([guide], "gemini-cli"))).toEqual({
			"GEMINI.md": "# Guide\n\nRun tests.\n",
		});
	});

	it("imports AGENTS.md from CLAUDE.md when another agent reads it too", () => {
		expect(fileMap(write([guide], "claude-code", "codex"))).toEqual({
			"AGENTS.md": "# Guide\n\nRun tests.\n",
			"CLAUDE.md": "@AGENTS.md\n",
		});
	});

	it("shares one AGENTS.md between Claude Code and Gemini CLI", () => {
		expect(fileMap(write([guide], "claude-code", "gemini-cli"))).toEqual({
			"AGENTS.md": "# Guide\n\nRun tests.\n",
			"CLAUDE.md": "@AGENTS.md\n",
			"GEMINI.md": "@./AGENTS.md\n",
		});
	});

	it("keeps an agent's own instructions out of the shared file", () => {
		const claudeOnly = instructions(
			"CLAUDE.md",
			"@AGENTS.md\n\n## Claude Code\n\nUse plan mode.\n",
		);
		const files = fileMap(write([guide, claudeOnly], "claude-code", "codex"));
		expect(files).toEqual({
			"AGENTS.md": "# Guide\n\nRun tests.\n",
			"CLAUDE.md": "@AGENTS.md\n\n## Claude Code\n\nUse plan mode.\n",
		});
		// With nothing else reading AGENTS.md, the text is inlined instead of imported.
		expect(fileMap(write([guide, claudeOnly], "claude-code"))).toEqual({
			"CLAUDE.md": "# Guide\n\nRun tests.\n\n## Claude Code\n\nUse plan mode.\n",
		});
		expect(fileMap(write([claudeOnly], "codex"))).toEqual({});
	});

	it("combines several in a stable order, once for identical text", () => {
		const style = instructions("Style", "Use tabs.");
		const testing = instructions("Testing", "Test first.\r\n");
		const copy = instructions("Style copy", "Use tabs.");
		const forward = write([testing, style, copy], "codex");
		expect(fileMap(forward)).toEqual({ "AGENTS.md": "Use tabs.\n\nTest first.\n" });
		expect(write([copy, style, testing], "codex")).toEqual(forward);
	});

	it("keeps nested files where they were", () => {
		const nested = instructions("packages/api/AGENTS.md", "API rules.\n");
		expect(fileMap(write([guide, nested], "codex"))).toEqual({
			"AGENTS.md": "# Guide\n\nRun tests.\n",
			"packages/api/AGENTS.md": "API rules.\n",
		});
		expect(fileMap(write([nested], "claude-code", "codex"))["packages/api/CLAUDE.md"]).toBe(
			"@AGENTS.md\n",
		);
	});

	it("writes Cursor rules and Claude rules only for their own agent", () => {
		const rule = asset(
			"instructions",
			"frontend/components",
			{ "components.mdc": "---\ndescription: UI\nalwaysApply: false\n---\nUse tokens.\n" },
			{ metadata: { alwaysApply: false } },
		);
		const claudeRule = instructions(".claude/rules/testing.md", "Test first.\n");
		const both = [rule, claudeRule];
		expect(fileMap(write(both, "cursor"))).toEqual({
			".cursor/rules/frontend/components.mdc":
				"---\ndescription: UI\nalwaysApply: false\n---\nUse tokens.\n",
		});
		expect(fileMap(write(both, "claude-code"))).toEqual({
			".claude/rules/testing.md": "Test first.\n",
		});
		const other = write(both, "codex", "gemini-cli");
		expect(other).toEqual({ files: [], problems: [] });
	});

	it("skips what has no text, and text that is front matter for another file", () => {
		const missing = write([instructions("AGENTS.md", null)], "codex");
		expect(missing.files).toEqual([]);
		expect(missing.problems).toEqual([
			{ asset: "AGENTS.md", message: expect.stringContaining("text") },
		]);
		const subagent = write(
			[instructions("reviewer", "---\nname: reviewer\n---\nReview.\n")],
			"codex",
		);
		expect(subagent.files).toEqual([]);
		expect(subagent.problems).toHaveLength(1);
	});

	it("refuses a name that would leave the repository", () => {
		const result = write([instructions("../outside/AGENTS.md", "x\n")], "codex");
		expect(result.files).toEqual([]);
		expect(result.problems).toHaveLength(1);
	});
});

describe("skills", () => {
	const review = asset(
		"skill",
		"review",
		{
			"SKILL.md": "---\nname: review\ndescription: Review code\n---\nLook.\n",
			"scripts/run.sh": "echo hi\n",
		},
		{ description: "Review code" },
	);

	it("writes Claude Code's folder and the shared one", () => {
		const claude = fileMap(write([review], "claude-code"));
		expect(Object.keys(claude)).toEqual([
			".claude/skills/review/SKILL.md",
			".claude/skills/review/scripts/run.sh",
		]);
		expect(claude[".claude/skills/review/scripts/run.sh"]).toBe("echo hi\n");
		for (const runtime of ["codex", "gemini-cli", "cursor"] as const) {
			expect(Object.keys(fileMap(write([review], runtime)))).toEqual([
				".agents/skills/review/SKILL.md",
				".agents/skills/review/scripts/run.sh",
			]);
		}
		expect(Object.keys(fileMap(write([review], "claude-code", "codex", "gemini-cli")))).toEqual([
			".agents/skills/review/SKILL.md",
			".agents/skills/review/scripts/run.sh",
			".claude/skills/review/SKILL.md",
			".claude/skills/review/scripts/run.sh",
		]);
	});

	it("never writes part of a skill", () => {
		const partial = asset("skill", "review", { "SKILL.md": "Look.\n", "assets/logo.png": null });
		const result = write([partial], "claude-code");
		expect(result.files).toEqual([]);
		expect(result.problems).toEqual([
			{ asset: "review", message: expect.stringContaining("assets/logo.png") },
		]);
	});

	it("needs a SKILL.md, a safe name and safe paths", () => {
		for (const bad of [
			asset("skill", "review", { "notes.md": "x\n" }),
			asset("skill", "../review", { "SKILL.md": "x\n" }),
			asset("skill", "review", { "SKILL.md": "x\n", "../escape.md": "x\n" }),
			asset("skill", "review", { "SKILL.md": "x\n", ".env": "SECRET=1\n" }),
		]) {
			const result = write([bad], "claude-code");
			expect(result.files).toEqual([]);
			expect(result.problems).toHaveLength(1);
		}
	});

	it("reports two different skills with one name", () => {
		const other = asset("skill", "review", { "SKILL.md": "Different.\n" });
		const result = write([review, other], "claude-code");
		expect(result.problems).toHaveLength(1);
		expect(write([other, review], "claude-code")).toEqual(result);
	});
});

describe("MCP servers", () => {
	const github = server("github", STDIO);
	const remote = server("acme", HTTP);

	it("writes .mcp.json with variable references for Claude Code", () => {
		const result = write([github, remote], "claude-code");
		expect(fileMap(result)[".mcp.json"]).toBe(`{
  "mcpServers": {
    "acme": {
      "headers": {
        "Authorization": "\${AUTHORIZATION}",
        "X-Team": "\${X_TEAM}"
      },
      "type": "http",
      "url": "https://mcp.acme.dev/mcp"
    },
    "github": {
      "args": [
        "-y",
        "@acme/mcp"
      ],
      "command": "npx",
      "env": {
        "ACME_TOKEN": "\${ACME_TOKEN}"
      }
    }
  }
}
`);
		expect(result.problems).toEqual([]);
	});

	it("uses Cursor's env: form", () => {
		const written = json(write([github, remote], "cursor"), ".cursor/mcp.json");
		expect(written).toEqual({
			mcpServers: {
				acme: {
					headers: { Authorization: ref("env:AUTHORIZATION"), "X-Team": ref("env:X_TEAM") },
					url: "https://mcp.acme.dev/mcp",
				},
				github: { ...STDIO, env: { ACME_TOKEN: ref("env:ACME_TOKEN") } },
			},
		});
	});

	it("writes Gemini CLI's httpUrl and $NAME references", () => {
		const written = json(write([github, remote], "gemini-cli"), ".gemini/settings.json");
		expect(written).toEqual({
			mcpServers: {
				acme: {
					headers: { Authorization: ref("AUTHORIZATION"), "X-Team": ref("X_TEAM") },
					httpUrl: "https://mcp.acme.dev/mcp",
				},
				github: { ...STDIO, env: { ACME_TOKEN: ref("ACME_TOKEN") } },
			},
		});
		const sse = server("legacy", { type: "sse", url: "https://old.acme.dev/sse" });
		expect(json(write([sse], "gemini-cli"), ".gemini/settings.json")).toEqual({
			mcpServers: { legacy: { url: "https://old.acme.dev/sse" } },
		});
	});

	it("forwards variables by name for Codex", () => {
		const files = fileMap(write([github, remote], "codex"));
		expect(Object.keys(files)).toEqual([".codex/config.toml"]);
		expect(parseToml(files[".codex/config.toml"] ?? "")).toEqual({
			mcp_servers: {
				acme: {
					env_http_headers: { Authorization: "AUTHORIZATION", "X-Team": "X_TEAM" },
					url: "https://mcp.acme.dev/mcp",
				},
				github: { args: ["-y", "@acme/mcp"], command: "npx", env_vars: ["ACME_TOKEN"] },
			},
		});
	});

	it("turns a bearer token variable into Authorization where the format has no template", () => {
		const bearer = server(
			"figma",
			{ url: "https://mcp.figma.com/mcp", bearer_token_env_var: "FIGMA_TOKEN" },
			"config.toml",
		);
		const claude = json(write([bearer], "claude-code"), ".mcp.json");
		expect(claude).toEqual({
			mcpServers: {
				figma: {
					headers: { Authorization: ref("FIGMA_TOKEN", "Bearer ") },
					type: "http",
					url: "https://mcp.figma.com/mcp",
				},
			},
		});
		const codex = fileMap(write([bearer], "codex"))[".codex/config.toml"] ?? "";
		expect(parseToml(codex)).toEqual({
			mcp_servers: {
				figma: { bearer_token_env_var: "FIGMA_TOKEN", url: "https://mcp.figma.com/mcp" },
			},
		});
	});

	it("reads each agent's own format", () => {
		const codexStored = server(
			"acme",
			{ command: "acme", env: { ACME_TOKEN: "<redacted>" }, startup_timeout_sec: 20 },
			"config.toml",
		);
		const geminiStored = server("gem", {
			httpUrl: "https://gem.dev/mcp",
			headers: { "X-Key": "<redacted>" },
			trust: true,
		});
		const claude = json(write([codexStored, geminiStored], "claude-code"), ".mcp.json");
		expect(claude).toEqual({
			mcpServers: {
				acme: { command: "acme", env: { ACME_TOKEN: ref("ACME_TOKEN") } },
				gem: { headers: { "X-Key": ref("X_KEY") }, type: "http", url: "https://gem.dev/mcp" },
			},
		});
		// Settings an agent has for itself stay with that agent's format only.
		const codex = fileMap(write([codexStored], "codex"))[".codex/config.toml"] ?? "";
		expect(parseToml(codex)).toEqual({
			mcp_servers: { acme: { command: "acme", env_vars: ["ACME_TOKEN"], startup_timeout_sec: 20 } },
		});
		const gemini = json(write([geminiStored], "gemini-cli"), ".gemini/settings.json");
		expect(gemini).toEqual({
			mcpServers: {
				gem: { headers: { "X-Key": ref("X_KEY") }, httpUrl: "https://gem.dev/mcp", trust: true },
			},
		});
	});

	it("keeps values that are not secrets", () => {
		const plain = server("plain", { command: "node", env: { MODE: "dev" } });
		expect(json(write([plain], "claude-code"), ".mcp.json")).toEqual({
			mcpServers: { plain: { command: "node", env: { MODE: "dev" } } },
		});
		const codex = fileMap(write([plain], "codex"))[".codex/config.toml"] ?? "";
		expect(parseToml(codex)).toEqual({
			mcp_servers: { plain: { command: "node", env: { MODE: "dev" } } },
		});
	});

	it("reports a server instead of writing a placeholder", () => {
		const cases = [
			server("arg", { command: "x", args: ["--token", "<redacted>"] }),
			server("url", { type: "http", url: "https://<redacted>@host/mcp" }),
			server("field", { command: "x", apiKey: "<redacted>" }),
			server("rename", { command: "x", env: { A: ref("B") } }),
		];
		for (const runtime of REPOSITORY_RUNTIMES) {
			const result = write([...cases, github], runtime);
			// A variable cannot be renamed on the way in Codex, which forwards by name.
			expect(result.problems.map((problem) => problem.asset)).toEqual(
				runtime === "codex" ? ["arg", "field", "rename", "url"] : ["arg", "field", "url"],
			);
			expect(result.files.map((file) => file.content).join("")).toContain("ACME_TOKEN");
			expect(result.files.map((file) => file.content).join("")).not.toContain("<redacted>");
		}
	});

	it("reports what a format cannot say", () => {
		const sse = server("legacy", { type: "sse", url: "https://old.acme.dev/sse" });
		const cwd = server("local", { command: "x", cwd: "tools" }, "config.toml");
		const codex = write([sse, cwd, github], "codex");
		expect(codex.problems.map((problem) => problem.asset)).toEqual(["legacy"]);
		const claude = write([sse, cwd, github], "claude-code");
		expect(claude.problems.map((problem) => problem.asset)).toEqual(["local"]);
		const cursor = write([cwd], "cursor");
		expect(cursor.problems.map((problem) => problem.asset)).toEqual(["local"]);
		expect(cursor.files).toEqual([]);
	});

	it("reports a server whose text is missing or unreadable", () => {
		const missing = asset("mcp-server", "gone", { ".mcp.json": null });
		const broken = asset("mcp-server", "broken", { ".mcp.json": "{ nope" });
		const result = write([missing, broken], "claude-code");
		expect(result.files).toEqual([]);
		expect(result.problems.map((problem) => problem.asset)).toEqual(["broken", "gone"]);
	});

	it("reports two different servers with one name", () => {
		const other = server("github", { command: "other" });
		const result = write([github, other], "claude-code");
		expect(result.problems).toHaveLength(1);
		expect(write([other, github], "claude-code")).toEqual(result);
	});
});

describe("what is not written", () => {
	it("reports kinds that have no file", () => {
		const unsupported = (["settings", "prompt", "script", "env-set", "plugin"] as const).map(
			(kind) => asset(kind, `a ${kind}`, { "x.txt": "x\n" }),
		);
		const result = write(unsupported, ...REPOSITORY_RUNTIMES);
		expect(result.files).toEqual([]);
		expect(result.problems.map((problem) => problem.asset)).toEqual(
			unsupported.map((item) => item.name).sort(),
		);
	});

	it("writes nothing without a runtime, and ignores a repeated one", () => {
		const guide = instructions("AGENTS.md", "x\n");
		expect(write([guide])).toEqual({ files: [], problems: [] });
		expect(write([guide], "codex", "codex")).toEqual(write([guide], "codex"));
	});
});

describe("byte stability", () => {
	const everything = [
		instructions("AGENTS.md", "# Guide\n"),
		instructions("CLAUDE.md", "Claude only.\n"),
		instructions("Testing", "Test first.\n"),
		asset("skill", "review", { "SKILL.md": "Look.\n", "b.md": "b\n", "a.md": "a\n" }),
		server("github", STDIO),
		server("acme", HTTP),
		asset("plugin", "p", { "x.json": "{}\n" }),
	];

	it("gives the same bytes for the same input in any order", () => {
		const expected = writeAssets(everything, [...REPOSITORY_RUNTIMES]);
		expect(expected.files.length).toBeGreaterThan(5);
		const reversed = writeAssets([...everything].reverse(), [...REPOSITORY_RUNTIMES].reverse());
		expect(reversed).toEqual(expected);
		const shuffled = [3, 0, 5, 1, 6, 2, 4].map((index) => everything[index] as AssetToWrite);
		expect(writeAssets(shuffled, ["gemini-cli", "claude-code", "cursor", "codex"])).toEqual(
			expected,
		);
	});

	it("ignores the order of keys in a stored server", () => {
		const a = server("s", { command: "x", args: ["1"], env: { B: "<redacted>", A: "<redacted>" } });
		const b = server("s", { env: { A: "<redacted>", B: "<redacted>" }, args: ["1"], command: "x" });
		for (const runtime of REPOSITORY_RUNTIMES) {
			expect(write([a], runtime)).toEqual(write([b], runtime));
		}
	});

	it("sorts files by path and ends every text with one newline and no CR", () => {
		const result = writeAssets(everything, [...REPOSITORY_RUNTIMES]);
		const paths = result.files.map((file) => file.path);
		expect(paths).toEqual([...paths].sort());
		for (const file of result.files) {
			expect(file.content).not.toContain("\r");
			expect(file.content.endsWith("\n")).toBe(true);
			expect(file.content.endsWith("\n\n")).toBe(false);
		}
	});

	it("never writes a redaction placeholder", () => {
		const result = writeAssets(everything, [...REPOSITORY_RUNTIMES]);
		for (const file of result.files) expect(file.content).not.toContain("<redacted>");
	});
});

describe("round trip through detect", () => {
	const source = repo({
		"AGENTS.md": "# Guide\n\nRun tests.\n",
		".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\nLook.\n",
		".claude/skills/review/scripts/run.sh": "echo hi\n",
		".mcp.json": JSON.stringify({
			mcpServers: {
				github: {
					command: "npx",
					args: ["-y", "@acme/mcp"],
					env: { ACME_TOKEN: "ghp_realsecretvalue1234567890abcdefghij" },
				},
				acme: {
					type: "http",
					url: "https://mcp.acme.dev/mcp",
					headers: { Authorization: "Bearer real-secret" },
				},
			},
		}),
	});

	function writable(): AssetToWrite[] {
		return detect(source).assets.map((found) => ({
			kind: found.kind,
			name: found.name,
			description: found.description,
			files: found.files.map((file) => ({ path: file.path, content: file.content ?? null })),
			metadata: found.metadata,
		}));
	}

	/** What an asset is, without where it sits: that differs between agents by design. */
	function shape(kind: AssetKind, assets: ReturnType<typeof detect>["assets"]) {
		return assets
			.filter((found) => found.kind === kind)
			.map((found) => ({
				name: found.name,
				description: found.description,
				files: found.files,
				metadata: found.metadata,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	function contents(kind: AssetKind, assets: ReturnType<typeof detect>["assets"]) {
		return assets
			.filter((found) => found.kind === kind)
			.flatMap((found) => found.files.map((file) => file.content));
	}

	function reread(runtime: RepositoryRuntime) {
		const written = writeAssets(writable(), [runtime]);
		expect(written.problems).toEqual([]);
		const tree = repo(Object.fromEntries(written.files.map((file) => [file.path, file.content])));
		return { written, found: detect(tree) };
	}

	const original = detect(source);

	for (const runtime of REPOSITORY_RUNTIMES) {
		it(`finds the same instructions, skills and servers for ${runtime}`, () => {
			const { found } = reread(runtime);
			expect(contents("instructions", found.assets)).toEqual(
				contents("instructions", original.assets),
			);
			expect(shape("skill", found.assets)).toEqual(shape("skill", original.assets));
			expect(
				found.assets
					.filter((item) => item.kind === "mcp-server")
					.map((item) => item.name)
					.sort(),
			).toEqual(["acme", "github"]);
		});
	}

	it("reads back a server's redacted text exactly for Claude Code, Cursor and Gemini CLI", () => {
		for (const runtime of ["claude-code", "cursor", "gemini-cli"] as const) {
			const { found } = reread(runtime);
			const github = found.assets.find(
				(item) => item.kind === "mcp-server" && item.name === "github",
			);
			const first = original.assets.find(
				(item) => item.kind === "mcp-server" && item.name === "github",
			);
			expect(github?.files[0]?.content).toBe(first?.files[0]?.content);
		}
	});

	it("reads back a Claude Code remote server exactly", () => {
		const { found } = reread("claude-code");
		const pick = (assets: typeof found.assets) =>
			assets.find((item) => item.kind === "mcp-server" && item.name === "acme")?.files[0]?.content;
		expect(pick(found.assets)).toBe(pick(original.assets));
	});

	it("keeps the Codex servers' command, arguments and variable names", () => {
		const { found } = reread("codex");
		const github = found.assets.find(
			(item) => item.kind === "mcp-server" && item.name === "github",
		);
		expect(parseToml(github?.files[0]?.content ?? "")).toEqual({
			args: ["-y", "@acme/mcp"],
			command: "npx",
			env_vars: ["ACME_TOKEN"],
		});
		const acme = found.assets.find((item) => item.kind === "mcp-server" && item.name === "acme");
		expect(acme?.metadata.headers).toEqual(["Authorization"]);
	});
});
