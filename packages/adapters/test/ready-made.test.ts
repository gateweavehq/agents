/**
 * The ready-made setups under `setups/` at the repository root ship to every workspace, so each
 * folder must read, write cleanly for the agents it names, and carry no secret. Adding a folder
 * adds its tests; nothing here lists them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { detect, readSetupFolder, type SetupFolder, wantsFile, writeAssets } from "../src";
import { repo } from "./support";

const ROOT = fileURLToPath(new URL("../../../setups", import.meta.url));

/** Every file below `dir`, dotfiles included, by path relative to it with forward slashes. */
function filesIn(dir: string, prefix = ""): Map<string, string> {
	const files = new Map<string, string>();
	for (const name of readdirSync(join(dir, prefix))) {
		const path = prefix === "" ? name : `${prefix}/${name}`;
		if (statSync(join(dir, path)).isDirectory()) {
			for (const [inner, text] of filesIn(dir, path)) files.set(inner, text);
		} else {
			files.set(path, readFileSync(join(dir, path), "utf8"));
		}
	}
	return files;
}

const slugs = readdirSync(ROOT).filter((name) => statSync(join(ROOT, name)).isDirectory());

function load(slug: string): { files: Map<string, string>; setup: SetupFolder } {
	const files = filesIn(join(ROOT, slug));
	const result = readSetupFolder(files);
	if (!result.ok) throw new Error(`${slug}: ${result.problems.join("; ")}`);
	return { files, setup: result.setup };
}

const REFERENCE = /^[^$]*\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}$/;
const CREDENTIAL = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}/;

describe("ready-made setups", () => {
	it("has at least one folder", () => {
		expect(slugs.length).toBeGreaterThan(0);
	});

	for (const slug of slugs) {
		describe(slug, () => {
			const { files, setup } = load(slug);
			const written = writeAssets(setup.assets, setup.runtimes);

			it("has no dotfiles", () => {
				const dotted = [...files.keys()].filter((path) =>
					path.split("/").some((part) => part.startsWith(".")),
				);
				expect(dotted).toEqual([]);
			});

			it("writes for its runtimes without problems", () => {
				expect(written.problems).toEqual([]);
				expect(written.files.length).toBeGreaterThan(0);
			});

			it("writes only files the scanner downloads", () => {
				const unwanted = written.files.map((file) => file.path).filter((path) => !wantsFile(path));
				expect(unwanted).toEqual([]);
			});

			for (const runtime of setup.runtimes) {
				it(`is found again from what it writes for ${runtime}`, () => {
					const result = writeAssets(setup.assets, [runtime]);
					expect(result.problems).toEqual([]);
					const found = detect(
						repo(Object.fromEntries(result.files.map((file) => [file.path, file.content]))),
					);
					expect(found.problems).toEqual([]);
					for (const asset of setup.assets) {
						const same = found.assets.filter((item) => item.kind === asset.kind);
						if (asset.kind === "instructions") {
							// Which file holds the text depends on the agent; the text is what must survive.
							const text = asset.files.map((file) => file.content?.trim());
							const read = same.flatMap((item) => item.files.map((file) => file.content));
							expect(
								read.some((content) => text.every((part) => content?.includes(part ?? ""))),
								`${asset.name} for ${runtime}`,
							).toBe(true);
						} else {
							const item = same.find((candidate) => candidate.name === asset.name);
							expect(item, `${asset.kind} ${asset.name} for ${runtime}`).toBeDefined();
							if (asset.kind === "skill") expect(item?.files).toEqual(asset.files);
						}
					}
				});
			}

			it("holds no literal token in the MCP configuration it writes", () => {
				const configs = written.files.filter((file) =>
					/(^|\/)(\.mcp\.json|mcp\.json|settings\.json|config\.toml)$/.test(file.path),
				);
				for (const file of configs) {
					expect(file.content, file.path).not.toMatch(CREDENTIAL);
					expect(file.content, file.path).not.toContain("<redacted>");
					const value: unknown = file.path.endsWith(".toml")
						? parseToml(file.content)
						: JSON.parse(file.content);
					const servers = (value as Record<string, Record<string, Record<string, unknown>>>)[
						file.path.endsWith(".toml") ? "mcp_servers" : "mcpServers"
					];
					for (const [name, server] of Object.entries(servers ?? {})) {
						// Codex names the variable instead of writing a template, and has no literal
						// token field but `http_headers`, which must stay empty.
						expect(server.http_headers, `${file.path} ${name}`).toBeUndefined();
						for (const field of ["env", "headers"]) {
							const table = server[field];
							if (table === undefined) continue;
							for (const [key, text] of Object.entries(table as Record<string, unknown>)) {
								expect(text, `${file.path} ${name} ${field}.${key}`).toMatch(REFERENCE);
							}
						}
					}
				}
			});
		});
	}
});
