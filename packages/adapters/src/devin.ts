/**
 * Devin, Cognition's Devin Desktop and Devin CLI, which Windsurf became. Docs, checked 2026-11-02:
 * - https://docs.devin.ai/cli/extensibility/rules (`.devin/rules/*.md` with `trigger`,
 *   `.devin/global_rules.md`, and Windsurf's `.windsurf/rules/*.md`, `.windsurf/global_rules.md`
 *   and `.windsurfrules`; `AGENTS.md`, `AGENT.md` and `CLAUDE.md`; `.devin/config.json`)
 * - https://docs.devin.ai/desktop/cascade/memories (where docs.windsurf.com's rules page now goes)
 *
 * Expected Windsurf's own docs; they redirect to Devin's, which read Windsurf's rule files as
 * "legacy", imported by default and loaded alongside `.devin/rules`. `.windsurf/global_rules.md`
 * is ignored when `.devin/global_rules.md` exists. `trigger` is `always_on`, `manual`,
 * `model_decision`, `agent` or `glob` (with `globs`). `AGENTS.local.md` and `config.local.json` are
 * personal and left out. Devin also reads Cursor's rules and Claude Code's files, which their own
 * adapters already find.
 */
import type { DetectedAsset, Metadata, ScanProblem } from "@gateweave/agents-model";
import { flatFields, instructionsAsset, setField } from "./assets";
import { readConfig, settingsAsset } from "./config";
import { Findings } from "./findings";
import { markdownAsset } from "./markdown";
import type { Adapter, Detection, RepositoryTree } from "./types";
import { basename, compare, str, truncate } from "./util";

const RULE_DIRS = [".devin/rules", ".windsurf/rules"] as const;
const GLOBAL_RULES = ".devin/global_rules.md";
const LEGACY_GLOBAL_RULES = ".windsurf/global_rules.md";
const LEGACY_RULES = ".windsurfrules";
const CONFIG = ".devin/config.json";
/** Other agents' always-on instructions, which Devin reads at any depth. */
const SHARED_INSTRUCTIONS = ["AGENTS.md", "AGENT.md"] as const;

function ruleDir(path: string): string | null {
	return RULE_DIRS.find((dir) => path.startsWith(`${dir}/`) && path.endsWith(".md")) ?? null;
}

function wants(path: string): boolean {
	if ([GLOBAL_RULES, LEGACY_GLOBAL_RULES, LEGACY_RULES, CONFIG].includes(path)) return true;
	if (ruleDir(path) !== null) return true;
	return (SHARED_INSTRUCTIONS as readonly string[]).includes(basename(path));
}

function detect(tree: RepositoryTree): Detection {
	const found = new Findings();
	const paths = [...tree.keys()].sort(compare);

	for (const path of paths) {
		const dir = ruleDir(path);
		if (dir) found.read(rule(tree, path, dir, found.problems));
	}
	if (tree.has(GLOBAL_RULES)) found.read(alwaysOn(tree, GLOBAL_RULES, found.problems));
	// Devin reads Windsurf's global rules only when it has none of its own.
	else if (tree.has(LEGACY_GLOBAL_RULES)) {
		found.read(alwaysOn(tree, LEGACY_GLOBAL_RULES, found.problems));
	}
	if (tree.has(LEGACY_RULES)) {
		const asset = instructionsAsset(tree, LEGACY_RULES, found.problems);
		if (asset) found.read({ ...asset, metadata: { legacy: true } });
	}
	const config = readConfig(tree, CONFIG, "json", found.problems);
	if (config) found.read(settingsAsset(config));

	// Everything above is Devin's own. `AGENTS.md` and `AGENT.md` are other agents' too, so they
	// are linked only once Devin itself is in the repository.
	if (found.reads.length === 0) return { agents: [], assets: [], problems: found.problems };
	for (const path of paths) {
		if ((SHARED_INSTRUCTIONS as readonly string[]).includes(basename(path))) {
			found.read(instructionsAsset(tree, path, found.problems));
		}
	}

	return {
		agents: [
			{
				runtime: "devin",
				key: "main",
				name: "Devin",
				description: null,
				model: null,
				path: null,
				metadata: {},
				assets: [...new Set(found.reads)].sort(compare),
			},
		],
		assets: found.assets,
		problems: found.problems,
	};
}

/** A rule in `.devin/rules` or Windsurf's `.windsurf/rules`, which `trigger` says when to load. */
function rule(
	tree: RepositoryTree,
	path: string,
	dir: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	return (
		markdownAsset(
			tree,
			path,
			"instructions",
			problems,
			(data) => {
				const metadata: Metadata = flatFields(data, ["description", "globs", "trigger"]);
				const trigger = str(data.trigger);
				if (trigger) setField(metadata, "trigger", trigger);
				const globs = globList(data.globs);
				if (globs.length > 0) setField(metadata, "globs", globs);
				if (dir === ".windsurf/rules") setField(metadata, "legacy", true);
				return {
					name: truncate(path.slice(dir.length + 1, -".md".length), 200),
					description: str(data.description),
					metadata,
				};
			},
			{ lenient: true },
		)?.asset ?? null
	);
}

/** A global rules file, always on. */
function alwaysOn(
	tree: RepositoryTree,
	path: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	const asset = instructionsAsset(tree, path, problems);
	if (!asset) return null;
	const metadata: Metadata = path === LEGACY_GLOBAL_RULES ? { legacy: true } : {};
	return { ...asset, metadata };
}

/** `globs` is one glob, a comma-separated line of them, or a list. */
function globList(value: unknown): string[] {
	const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return items.flatMap((item) =>
		typeof item === "string" && item.trim() !== "" ? [item.trim()] : [],
	);
}

export const devin: Adapter = { runtime: "devin", wants, detect };
