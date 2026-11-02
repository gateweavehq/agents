/**
 * Instructions. Docs, checked 2026-10-28:
 * - https://code.claude.com/docs/en/memory (`./CLAUDE.md`, `@path` imports relative to the
 *   importing file, `.claude/rules/*.md`; Claude reads `AGENTS.md` only when no `CLAUDE.md` is
 *   in the way, and the documented way to share one is a `CLAUDE.md` that starts with `@AGENTS.md`)
 * - https://learn.chatgpt.com/docs/agent-configuration/agents-md (Codex reads `AGENTS.md`)
 * - https://geminicli.com/docs/cli/gemini-md/ (`GEMINI.md`, `@./file.md` imports; `AGENTS.md`
 *   is not read unless `context.fileName` lists it)
 * - https://cursor.com/docs/context/rules (`.cursor/rules/**.mdc`; `AGENTS.md` in the project
 *   root and subdirectories)
 * - https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
 *   (checked 2026-11-02: GitHub Copilot reads `AGENTS.md` anywhere, the nearest winning, and
 *   `.github/instructions/**.instructions.md` with `applyTo`)
 * - https://docs.devin.ai/cli/extensibility/rules (checked 2026-11-02: Devin reads `AGENTS.md`)
 *
 * Instruction assets are named by the path they were read from, so that is where they go back:
 * `packages/api/AGENTS.md` stays in `packages/api`. Per folder, the text of every asset not
 * named `CLAUDE.md` or `GEMINI.md` is shared; it is combined in name order into `AGENTS.md`,
 * which Codex, Cursor, GitHub Copilot and Devin read. `CLAUDE.md` and `GEMINI.md` assets are that agent's own addition.
 *
 * `CLAUDE.md` and `GEMINI.md` import `AGENTS.md` instead of repeating it when another agent
 * reads it too (Codex or Cursor, or Claude Code and Gemini CLI together). One copy cannot drift
 * from the other, and the import works on every Claude Code version, where reading `AGENTS.md`
 * directly needs a recent one. When nothing else reads `AGENTS.md`, writing it only to import it
 * would be a file for nobody, so the text goes straight into the agent's own file.
 *
 * Cursor rules (instructions with an `alwaysApply` field, as the Cursor reader stores them),
 * Copilot's path-specific instructions (a `.instructions.md` file) and `.claude/rules` files only
 * mean something to their own agent, so other runtimes ignore them without a problem.
 */
import type { RepositoryRuntime } from "@gateweave/agents-model";
import { basename, compare, dirname } from "./util";
import type { AssetToWrite } from "./write";
import { isSafePath, normalizeText, type Output, singleText } from "./write-output";

/** Names that are a file's own path, so the folder part says where the file sits. */
const KNOWN_FILES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules"]);
const CLAUDE_RULE = /(^|\/)\.claude\/rules\/.+\.md$/;
const FRONT_MATTER = /^﻿?---[ \t]*\r?\n/;
const AGENTS_IMPORT = /^[ \t]*@(\.\/)?AGENTS\.md[ \t]*$/;

interface Folder {
	shared: string[];
	claude: string[];
	gemini: string[];
}

export function writeInstructions(
	assets: readonly AssetToWrite[],
	targets: ReadonlySet<RepositoryRuntime>,
	output: Output,
): void {
	const folders = new Map<string, Folder>();
	for (const asset of assets) {
		const text = singleText(asset, output);
		if (text === null) continue;

		if (isCursorRule(asset)) {
			// The reader stores a rule under its path inside `.cursor/rules`, without `.mdc`.
			const path = `.cursor/rules/${asset.name}.mdc`;
			if (!targets.has("cursor")) continue;
			if (isSafePath(path)) output.add(path, text, asset.name);
			else output.problem(asset.name, "The rule's name is not a usable path");
			continue;
		}
		if (isCopilotInstructions(asset)) {
			// The reader names them by their path inside `.github/instructions`, without the suffix.
			const path = `.github/instructions/${asset.name}.instructions.md`;
			if (!targets.has("copilot")) continue;
			if (isSafePath(path)) output.add(path, text, asset.name);
			else output.problem(asset.name, "The instructions' name is not a usable path");
			continue;
		}
		if (CLAUDE_RULE.test(asset.name)) {
			if (!targets.has("claude-code")) continue;
			if (isSafePath(asset.name)) output.add(asset.name, text, asset.name);
			else output.problem(asset.name, "The rule's name is not a usable path");
			continue;
		}
		if (basename(asset.name) === "AGENTS.override.md") {
			output.problem(
				asset.name,
				"AGENTS.override.md replaces AGENTS.md for Codex and is not written",
			);
			continue;
		}
		if (FRONT_MATTER.test(text)) {
			output.problem(
				asset.name,
				"The text starts with front matter, which only means something in the file it came from",
			);
			continue;
		}

		const place = placeOf(asset.name);
		if (place === null) {
			output.problem(asset.name, "The name is not a usable path");
			continue;
		}
		const folder = folders.get(place.folder) ?? { shared: [], claude: [], gemini: [] };
		folders.set(place.folder, folder);
		folder[place.scope].push(text);
	}

	for (const path of [...folders.keys()].sort(compare)) {
		const folder = folders.get(path);
		if (folder) writeFolder(path, folder, targets, output);
	}
}

/** Cursor's reader gives every rule an `alwaysApply` flag; the legacy `.cursorrules` has none. */
function isCursorRule(asset: AssetToWrite): boolean {
	return typeof asset.metadata.alwaysApply === "boolean";
}

/** Copilot's reader keeps a path-specific instructions file under its own file name. */
function isCopilotInstructions(asset: AssetToWrite): boolean {
	const [file] = asset.files;
	return asset.files.length === 1 && file !== undefined && file.path.endsWith(".instructions.md");
}

function placeOf(name: string): { folder: string; scope: keyof Folder } | null {
	const file = basename(name);
	let folder = KNOWN_FILES.has(file) ? dirname(name) : "";
	const scope = file === "CLAUDE.md" ? "claude" : file === "GEMINI.md" ? "gemini" : "shared";
	// `.claude/CLAUDE.md` is the same file as `CLAUDE.md` for Claude Code.
	if (scope === "claude" && basename(folder) === ".claude") folder = dirname(folder);
	if (folder !== "" && !isSafePath(folder)) return null;
	return { folder, scope };
}

function writeFolder(
	folder: string,
	parts: Folder,
	targets: ReadonlySet<RepositoryRuntime>,
	output: Output,
): void {
	const at = (file: string) => (folder === "" ? file : `${folder}/${file}`);
	const shared = join(parts.shared);
	// A conflict in a folder is reported against the folder's AGENTS.md.
	const owner = at("AGENTS.md");
	const readsAgents = ["codex", "cursor", "copilot", "devin"].some((runtime) =>
		targets.has(runtime as RepositoryRuntime),
	);
	const both = targets.has("claude-code") && targets.has("gemini-cli");
	const agentsFile = shared !== "" && (readsAgents || both);

	if (agentsFile) output.add(at("AGENTS.md"), shared, owner);
	if (targets.has("claude-code")) {
		const body = join(parts.claude.map(withoutImport));
		const text = agentsFile ? join(["@AGENTS.md", body]) : join([shared, body]);
		if (text !== "") output.add(at("CLAUDE.md"), text, owner);
	}
	if (targets.has("gemini-cli")) {
		const body = join(parts.gemini.map(withoutImport));
		const text = agentsFile ? join(["@./AGENTS.md", body]) : join([shared, body]);
		if (text !== "") output.add(at("GEMINI.md"), text, owner);
	}
}

/** The agent's own file may import `AGENTS.md` itself; the writer decides that, not the text. */
function withoutImport(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !AGENTS_IMPORT.test(line))
		.join("\n")
		.replace(/^\n+/, "");
}

/** Texts one after another, each once, with a blank line between and one newline at the end. */
function join(texts: readonly string[]): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const text of texts) {
		const trimmed = normalizeText(text).trimEnd();
		if (trimmed.trim() === "" || seen.has(trimmed)) continue;
		seen.add(trimmed);
		parts.push(trimmed);
	}
	return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}
