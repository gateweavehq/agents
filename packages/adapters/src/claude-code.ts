/**
 * Claude Code. Docs, checked 2026-10-28:
 * - https://code.claude.com/docs/en/memory (CLAUDE.md, .claude/rules, AGENTS.md)
 * - https://code.claude.com/docs/en/skills
 * - https://code.claude.com/docs/en/sub-agents
 * - https://code.claude.com/docs/en/mcp (.mcp.json)
 * - https://code.claude.com/docs/en/plugins-reference (.claude-plugin/plugin.json; the page now
 *   redirects to the manifest reference and the standard layout:
 *   https://code.claude.com/docs/en/plugins/manifest-reference)
 * - https://code.claude.com/docs/en/plugin-marketplaces (marketplace.json and relative plugin paths)
 *
 * Plugins: the manifest is the only file in `.claude-plugin/`; every component (skills/,
 * commands/, agents/, hooks/hooks.json, .mcp.json, .lsp.json, ...) sits in the plugin root beside
 * it, and "Put every other plugin file at the plugin root, not inside .claude-plugin/". The
 * manifest itself is optional in the docs; we only find plugins that have one.
 *
 * Skipped on purpose: CLAUDE.local.md and .claude/settings.local.json, which are personal and
 * normally gitignored.
 */
import type { DetectedAgent, DetectedAsset, ScanProblem } from "@gateweave/agents-model";
import {
	addProblem,
	directoryFiles,
	flatFields,
	instructionsAsset,
	parseJsonConfig,
	readText,
	redactedText,
	setField,
} from "./assets";
import { mcpServerAssets, readConfig, settingsAsset } from "./config";
import { Findings } from "./findings";
import { markdownAsset } from "./markdown";
import { redact } from "./redaction";
import { skillAssets } from "./skills";
import type { Adapter, Detection, RepositoryTree } from "./types";
import {
	basename,
	compare,
	dirname,
	firstLine,
	isEnvFile,
	isPlainObject,
	str,
	truncate,
	under,
	withoutExtension,
} from "./util";

const SKILL_ROOT = ".claude/skills";
const SETTINGS = ".claude/settings.json";
const MCP = ".mcp.json";

function isMarkdown(path: string): boolean {
	return path.endsWith(".md");
}

function wants(path: string): boolean {
	if (basename(path) === "CLAUDE.md") return true;
	if (path === SETTINGS) return true;
	// `wants` sees one path at a time, so it takes the plugin files that are recognizable alone.
	if (under(path, ".claude-plugin")) return true;
	if (basename(path) === MCP || path === "hooks/hooks.json" || path.endsWith("/hooks/hooks.json")) {
		return true;
	}
	if (under(path, SKILL_ROOT)) return !isEnvFile(path);
	return (
		isMarkdown(path) &&
		[".claude/rules", ".claude/commands", ".claude/agents"].some((root) => under(path, root))
	);
}

function detect(tree: RepositoryTree): Detection {
	const found = new Findings();
	const subagents: DetectedAgent[] = [];
	const paths = [...tree.keys()].sort(compare);

	for (const path of paths) {
		if (basename(path) === "CLAUDE.md") {
			const asset = instructionsAsset(tree, path, found.problems);
			found.read(asset);
			if (asset) importedAgentsFile(tree, path, found);
			continue;
		}
		if (!isMarkdown(path)) continue;
		if (under(path, ".claude/rules")) {
			found.read(rule(tree, path, found.problems));
			continue;
		}
		const command = under(path, ".claude/commands");
		if (command) {
			found.read(slashCommand(tree, path, command.rest, found.problems));
			continue;
		}
		if (under(path, ".claude/agents")) {
			const subagent = subagentOf(tree, path, found.problems);
			if (subagent) {
				found.assets.push(subagent.asset);
				subagents.push(subagent.agent);
			}
		}
	}

	found.readAll(skillAssets(tree, [SKILL_ROOT], found.problems));

	const settings = readConfig(tree, SETTINGS, "json", found.problems);
	let model: string | null = null;
	if (settings) {
		model = str(settings.parsed.model);
		found.read(settingsAsset(settings));
	}
	const mcp = readConfig(tree, MCP, "json", found.problems);
	if (mcp) found.readAll(mcpServerAssets(mcp, mcp.parsed.mcpServers, found.problems));

	const manifests = pluginManifests(paths);
	const roots = manifests.map((manifest) => dirname(dirname(manifest)));
	for (const manifest of manifests) found.read(plugin(tree, manifest, roots, found.problems));

	// A repository whose only Claude Code files are subagents still has Claude Code in it.
	const agents = [...subagents];
	if (found.reads.length > 0 || subagents.length > 0) {
		readAgentsFile(tree, found);
		agents.push({
			runtime: "claude-code",
			key: "main",
			name: "Claude Code",
			description: null,
			model,
			path: null,
			metadata: {},
			assets: [...new Set(found.reads)].sort(compare),
		});
	}
	return { agents, assets: found.assets, problems: found.problems };
}

/**
 * Claude Code reads `AGENTS.md` only when no `CLAUDE.md` is in the way, or when a `CLAUDE.md`
 * imports it with `@AGENTS.md`. The first case is decided once all files are known
 * (`readAgentsFile`).
 */
function importedAgentsFile(tree: RepositoryTree, claudePath: string, found: Findings): void {
	const text = tree.get(claudePath)?.content;
	if (text === undefined || !/(^|\s)@(\.\/)?AGENTS\.md\b/.test(text)) return;
	const directory = dirname(claudePath);
	const target = directory === "" ? "AGENTS.md" : `${directory}/AGENTS.md`;
	const asset = instructionsAsset(tree, target, found.problems);
	found.read(asset);
}

function readAgentsFile(tree: RepositoryTree, found: Findings): void {
	const hasProjectClaudeMd = tree.has("CLAUDE.md") || tree.has(".claude/CLAUDE.md");
	if (!hasProjectClaudeMd) found.read(instructionsAsset(tree, "AGENTS.md", found.problems));
}

function rule(tree: RepositoryTree, path: string, problems: ScanProblem[]): DetectedAsset | null {
	return (
		markdownAsset(tree, path, "instructions", problems, (data) => ({
			name: path,
			description: null,
			// `paths` scopes a rule to matching files; without it the rule always loads.
			metadata: flatFields(data),
		}))?.asset ?? null
	);
}

function slashCommand(
	tree: RepositoryTree,
	path: string,
	relative: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	return (
		markdownAsset(tree, path, "prompt", problems, (data, body) => ({
			// Subfolders namespace a command: `git/commit.md` is `/git:commit`.
			name: withoutExtension(relative, ".md").replaceAll("/", ":"),
			description: str(data.description) ?? firstLine(body),
			metadata: flatFields(data, ["description"]),
		}))?.asset ?? null
	);
}

function subagentOf(
	tree: RepositoryTree,
	path: string,
	problems: ScanProblem[],
): { asset: DetectedAsset; agent: DetectedAgent } | null {
	const stem = withoutExtension(basename(path), ".md");
	const result = markdownAsset(tree, path, "instructions", problems, (data) => ({
		name: str(data.name) ?? stem,
		description: str(data.description),
		metadata: flatFields(data, ["name", "description"]),
	}));
	if (!result) return null;
	const { asset, data } = result;
	const model = str(data.model);
	return {
		asset,
		agent: {
			runtime: "claude-code",
			key: path,
			name: asset.name,
			description: asset.description,
			model: model === null ? null : truncate(model, 200),
			path,
			metadata: asset.metadata,
			assets: [path],
		},
	};
}

/** Where a plugin keeps its components when its manifest does not say otherwise. */
const PLUGIN_COMPONENT_ROOTS = [
	".claude-plugin",
	"skills",
	"commands",
	"agents",
	"hooks",
	"output-styles",
	"workflows",
	"themes",
	"monitors",
	"bin",
];
const PLUGIN_COMPONENT_FILES = [".mcp.json", ".lsp.json", "settings.json", "SKILL.md"];

/** Manifest keys whose values are paths (or lists of them) to components. */
const PLUGIN_PATH_KEYS = [
	"skills",
	"commands",
	"agents",
	"hooks",
	"mcpServers",
	"lspServers",
	"outputStyles",
	"workflows",
];

/** The `plugin.json` files of the tree: one plugin each, rooted above its `.claude-plugin`. */
function pluginManifests(paths: readonly string[]): string[] {
	return paths.filter(
		(path) => basename(path) === "plugin.json" && basename(dirname(path)) === ".claude-plugin",
	);
}

/** Paths a manifest points at, inside the plugin. The plugin root itself and anything outside are ignored. */
function declaredComponentPaths(manifest: Record<string, unknown>): string[] {
	const values: unknown[] = PLUGIN_PATH_KEYS.map((key) => manifest[key]);
	const experimental = manifest.experimental;
	if (isPlainObject(experimental)) values.push(experimental.themes, experimental.monitors);
	if (isPlainObject(manifest.commands)) {
		for (const command of Object.values(manifest.commands)) {
			if (isPlainObject(command)) values.push(command.source);
		}
	}
	const found: string[] = [];
	for (const value of values.flat()) {
		if (typeof value !== "string") continue;
		const path = value.replace(/^\.\//, "").replace(/\/+$/, "");
		if (path === "" || path === "." || path.split("/").includes("..") || /^[a-z]+:/i.test(path)) {
			continue;
		}
		found.push(path);
	}
	return found;
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

/**
 * A plugin is its root folder, the parent of `.claude-plugin`: its components live beside the
 * manifest, so a change to a command or a hook must change the asset. Configuration is stored
 * redacted like any other; the rest is given by blob and size, which is all the hash needs.
 */
function plugin(
	tree: RepositoryTree,
	manifest: string,
	roots: readonly string[],
	problems: ScanProblem[],
): DetectedAsset | null {
	const root = dirname(dirname(manifest));
	const text = readText(tree, manifest, problems);
	if (text === null) return null;
	const parsed = parseJsonConfig(text);
	if (!parsed.ok) {
		addProblem(problems, manifest, parsed.message);
		return null;
	}
	// A repository-root plugin cannot be "" as a path, so it keeps the `.claude-plugin` key that
	// the manifest's folder always had; its files are still relative to the plugin root.
	const path = root === "" ? ".claude-plugin" : root;
	// Another plugin's folder is not this plugin's, however deep it sits.
	const others = roots.filter((other) => other !== root && (root === "" || isWithin(other, root)));
	const declared = declaredComponentPaths(parsed.value);
	const include = (relative: string): boolean => {
		const full = root === "" ? relative : `${root}/${relative}`;
		if (relative.startsWith("node_modules/") || relative.includes("/node_modules/")) return false;
		if (others.some((other) => isWithin(full, other))) return false;
		// At the repository root the plugin's folder is the whole repository: take only components.
		if (root !== "") return true;
		return (
			PLUGIN_COMPONENT_FILES.includes(relative) ||
			PLUGIN_COMPONENT_ROOTS.some((dir) => isWithin(relative, dir)) ||
			declared.some((declaredPath) => isWithin(relative, declaredPath))
		);
	};
	const files = directoryFiles(
		tree,
		root,
		problems,
		(relative, content) => {
			if (!isPluginConfig(relative)) return null;
			const json = parseJsonConfig(content);
			if (json.ok) return redactedText(json.value, "json");
			addProblem(problems, root === "" ? relative : `${root}/${relative}`, json.message);
			return null;
		},
		{ include, problemPath: path },
	);
	const safe = redact(parsed.value);
	const fields = isPlainObject(safe) ? safe : {};
	const metadata = flatFields(fields, ["name", "description"]);
	const author = isPlainObject(fields.author) ? str(fields.author.name) : str(fields.author);
	if (author) setField(metadata, "author", truncate(author, 2000));
	const description = str(parsed.value.description);
	return {
		kind: "plugin",
		key: path,
		name: truncate(str(parsed.value.name) ?? (basename(root) || "plugin"), 200),
		description: description === null ? null : truncate(description, 2000),
		path,
		files,
		metadata,
	};
}

/** Files of a plugin whose text is kept: its manifests and the two component configurations. */
function isPluginConfig(relative: string): boolean {
	if (relative === MCP || relative === "hooks/hooks.json") return true;
	return relative.startsWith(".claude-plugin/") && relative.endsWith(".json");
}

export const claudeCode: Adapter = { runtime: "claude-code", wants, detect };
