/**
 * Cursor. Docs, checked 2026-10-28:
 * - https://cursor.com/docs/context/rules (`.cursor/rules/**.mdc`, `AGENTS.md`)
 * - https://cursor.com/docs/context/mcp (`.cursor/mcp.json`)
 * - https://cursor.com/docs/skills (`.cursor/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`)
 *
 * Project rules must be `.mdc`; Cursor ignores a plain `.md` in `.cursor/rules`. `.cursorrules` is
 * the legacy single-file form, which the docs no longer describe but Cursor still reads.
 */
import type { DetectedAsset, Metadata, ScanProblem } from "@gateweave/agents-model";
import { flatFields, instructionsAsset, setField } from "./assets";
import { mcpServerAssets, readConfig } from "./config";
import { Findings } from "./findings";
import { markdownAsset } from "./markdown";
import { skillAssets } from "./skills";
import type { Adapter, Detection, RepositoryTree } from "./types";
import { basename, compare, isEnvFile, str, truncate, under, withoutExtension } from "./util";

const RULES = ".cursor/rules";
const MCP = ".cursor/mcp.json";
const LEGACY_RULES = ".cursorrules";
const OWN_SKILL_ROOTS = [".cursor/skills"] as const;
/** Cursor also loads other agents' skill folders. */
const SHARED_SKILL_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;

function wants(path: string): boolean {
	if (path === MCP || path === LEGACY_RULES) return true;
	if (path.endsWith(".mdc") && under(path, RULES)) return true;
	return (
		[...OWN_SKILL_ROOTS, ...SHARED_SKILL_ROOTS].some((root) => under(path, root) !== null) &&
		!isEnvFile(path)
	);
}

function detect(tree: RepositoryTree): Detection {
	const found = new Findings();
	const paths = [...tree.keys()].sort(compare);

	for (const path of paths) {
		const rule = under(path, RULES);
		if (rule && path.endsWith(".mdc"))
			found.read(projectRule(tree, path, rule.rest, found.problems));
	}
	if (tree.has(LEGACY_RULES)) {
		const asset = instructionsAsset(tree, LEGACY_RULES, found.problems);
		if (asset) found.read({ ...asset, metadata: { legacy: true } });
	}
	const mcp = readConfig(tree, MCP, "json", found.problems);
	if (mcp) found.readAll(mcpServerAssets(mcp, mcp.parsed.mcpServers, found.problems));
	found.readAll(skillAssets(tree, OWN_SKILL_ROOTS, found.problems));

	// Everything above is Cursor's own. The files below are other agents' that Cursor also reads,
	// so they are linked only once Cursor itself is in the repository.
	if (found.reads.length === 0) return { agents: [], assets: [], problems: found.problems };
	for (const path of paths) {
		if (basename(path) === "AGENTS.md") found.read(instructionsAsset(tree, path, found.problems));
	}
	found.readAll(skillAssets(tree, SHARED_SKILL_ROOTS, found.problems));

	return {
		agents: [
			{
				runtime: "cursor",
				key: "main",
				name: "Cursor",
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

function projectRule(
	tree: RepositoryTree,
	path: string,
	relative: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	return (
		markdownAsset(
			tree,
			path,
			"instructions",
			problems,
			(data) => {
				const metadata: Metadata = flatFields(data, ["description", "globs", "alwaysApply"]);
				const globs = globList(data.globs);
				if (globs.length > 0) setField(metadata, "globs", globs);
				setField(metadata, "alwaysApply", data.alwaysApply === true || data.alwaysApply === "true");
				return {
					name: truncate(withoutExtension(relative, ".mdc"), 200),
					description: str(data.description),
					metadata,
				};
			},
			{ lenient: true },
		)?.asset ?? null
	);
}

/** Cursor writes `globs` as a list or as one comma-separated line. */
function globList(value: unknown): string[] {
	const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return items.flatMap((item) =>
		typeof item === "string" && item.trim() !== "" ? [item.trim()] : [],
	);
}

export const cursor: Adapter = { runtime: "cursor", wants, detect };
