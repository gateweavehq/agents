/**
 * Claude Code. Docs, checked 2026-10-28:
 * - https://code.claude.com/docs/en/memory (CLAUDE.md, .claude/rules, AGENTS.md)
 * - https://code.claude.com/docs/en/skills
 * - https://code.claude.com/docs/en/sub-agents
 * - https://code.claude.com/docs/en/mcp (.mcp.json)
 * - https://code.claude.com/docs/en/plugins-reference (.claude-plugin/plugin.json)
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
	if (path === MCP || path === SETTINGS) return true;
	if (under(path, ".claude-plugin")) return true;
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

	for (const path of paths) {
		if (basename(path) === "plugin.json" && basename(dirname(path)) === ".claude-plugin") {
			found.read(plugin(tree, path, found.problems));
		}
	}

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

/** A plugin is its `.claude-plugin` folder; manifests are redacted like any other configuration. */
function plugin(
	tree: RepositoryTree,
	manifest: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	const directory = dirname(manifest);
	const text = readText(tree, manifest, problems);
	if (text === null) return null;
	const parsed = parseJsonConfig(text);
	if (!parsed.ok) {
		addProblem(problems, manifest, parsed.message);
		return null;
	}
	const files = directoryFiles(tree, directory, problems, (relative, content) => {
		if (!relative.endsWith(".json")) return content;
		const json = parseJsonConfig(content);
		if (json.ok) return redactedText(json.value, "json");
		addProblem(problems, `${directory}/${relative}`, json.message);
		return null;
	});
	const safe = redact(parsed.value);
	const fields = isPlainObject(safe) ? safe : {};
	const metadata = flatFields(fields, ["name", "description"]);
	const author = isPlainObject(fields.author) ? str(fields.author.name) : str(fields.author);
	if (author) setField(metadata, "author", truncate(author, 2000));
	const description = str(parsed.value.description);
	return {
		kind: "plugin",
		key: directory,
		name: truncate(str(parsed.value.name) ?? (basename(dirname(directory)) || "plugin"), 200),
		description: description === null ? null : truncate(description, 2000),
		path: directory,
		files,
		metadata,
	};
}

export const claudeCode: Adapter = { runtime: "claude-code", wants, detect };
