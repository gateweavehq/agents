/**
 * GitHub Copilot. Docs, checked 2026-11-02:
 * - https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
 *   (`.github/copilot-instructions.md`; `.github/instructions/**.instructions.md` with `applyTo`
 *   and `excludeAgent`; `AGENTS.md` anywhere, the nearest winning; `CLAUDE.md` or `GEMINI.md` at
 *   the root as an alternative)
 * - https://docs.github.com/en/copilot/reference/customization-cheat-sheet (`.github/prompts`,
 *   `.github/agents`, skills in `.github/skills`, `.claude/skills` and `.agents/skills`, hooks in
 *   `.github/hooks`)
 * - https://docs.github.com/en/copilot/reference/custom-agents-configuration (a custom agent's
 *   file is `NAME.md` or `NAME.agent.md`, with `name`, `description`, `target`, `tools`, `model`)
 * - https://code.visualstudio.com/docs/copilot/customization/prompt-files (`.prompt.md`, with
 *   `description`, `name`, `argument-hint`, `agent`, `model`, `tools`)
 * - https://code.visualstudio.com/docs/copilot/reference/mcp-configuration (`.vscode/mcp.json`,
 *   whose servers are under `servers`, not `mcpServers` as elsewhere)
 *
 * The docs name no fixed folder depth for instructions, so `.github/instructions` is read with its
 * subfolders. Chat modes (`.chatmode.md`) are the older name of custom agents; VS Code still reads
 * `.github/chatmodes`, so both are read as agents' definitions. Hooks are left for later: the docs
 * give their folder but not yet a stable format.
 */
import type { DetectedAsset, Metadata, ScanProblem } from "@gateweave/agents-model";
import { stringify } from "yaml";
import { flatFields, instructionsAsset, setField } from "./assets";
import { mcpServerAssets, readConfig } from "./config";
import { Findings } from "./findings";
import { markdownAsset } from "./markdown";
import { redact } from "./redaction";
import { skillAssets } from "./skills";
import type { Adapter, Detection, RepositoryTree } from "./types";
import {
	basename,
	compare,
	firstLine,
	isEnvFile,
	isPlainObject,
	str,
	truncate,
	under,
} from "./util";

const INSTRUCTIONS = ".github/copilot-instructions.md";
const PATH_INSTRUCTIONS = ".github/instructions";
const PROMPTS = ".github/prompts";
const AGENTS = ".github/agents";
const CHAT_MODES = ".github/chatmodes";
const MCP = ".vscode/mcp.json";
const OWN_SKILL_ROOTS = [".github/skills"] as const;
/** Copilot also loads other agents' skill folders. */
const SHARED_SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;
/** Instructions Copilot reads at the root, as an alternative to `AGENTS.md`. */
const SHARED_ROOT_INSTRUCTIONS = ["CLAUDE.md", "GEMINI.md"] as const;

function wants(path: string): boolean {
	if (path === INSTRUCTIONS || path === MCP) return true;
	if (path.startsWith(`${PATH_INSTRUCTIONS}/`) && path.endsWith(".instructions.md")) return true;
	if (path.startsWith(`${PROMPTS}/`) && path.endsWith(".prompt.md")) return true;
	if (path.startsWith(`${AGENTS}/`) && path.endsWith(".md")) return true;
	if (path.startsWith(`${CHAT_MODES}/`) && path.endsWith(".chatmode.md")) return true;
	if (basename(path) === "AGENTS.md") return true;
	if ((SHARED_ROOT_INSTRUCTIONS as readonly string[]).includes(path)) return true;
	return (
		[...OWN_SKILL_ROOTS, ...SHARED_SKILL_ROOTS].some((root) => under(path, root) !== null) &&
		!isEnvFile(path)
	);
}

function detect(tree: RepositoryTree): Detection {
	const found = new Findings();
	const paths = [...tree.keys()].sort(compare);

	if (tree.has(INSTRUCTIONS)) found.read(instructionsAsset(tree, INSTRUCTIONS, found.problems));
	for (const path of paths) {
		if (path.startsWith(`${PATH_INSTRUCTIONS}/`) && path.endsWith(".instructions.md")) {
			found.read(pathInstructions(tree, path, found.problems));
		} else if (path.startsWith(`${PROMPTS}/`) && path.endsWith(".prompt.md")) {
			found.read(promptFile(tree, path, found.problems));
		} else if (path.startsWith(`${AGENTS}/`) && path.endsWith(".md")) {
			found.read(customAgent(tree, path, ".md", found.problems));
		} else if (path.startsWith(`${CHAT_MODES}/`) && path.endsWith(".chatmode.md")) {
			found.read(customAgent(tree, path, ".chatmode.md", found.problems));
		}
	}
	const mcp = readConfig(tree, MCP, "json", found.problems);
	if (mcp) found.readAll(mcpServerAssets(mcp, mcp.parsed.servers, found.problems));
	found.readAll(skillAssets(tree, OWN_SKILL_ROOTS, found.problems));

	// Everything above is Copilot's own. The files below are other agents' that Copilot also reads,
	// so they are linked only once Copilot itself is in the repository: `.vscode/mcp.json` alone
	// says VS Code, which Copilot runs in, so it counts as Copilot's.
	if (found.reads.length === 0) return { agents: [], assets: [], problems: found.problems };
	for (const path of paths) {
		if (basename(path) === "AGENTS.md") found.read(instructionsAsset(tree, path, found.problems));
	}
	for (const path of SHARED_ROOT_INSTRUCTIONS) {
		if (tree.has(path)) found.read(instructionsAsset(tree, path, found.problems));
	}
	found.readAll(skillAssets(tree, SHARED_SKILL_ROOTS, found.problems));

	return {
		agents: [
			{
				runtime: "copilot",
				key: "main",
				name: "GitHub Copilot",
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

/** A path-specific instructions file: `applyTo` scopes it, `excludeAgent` keeps it from one. */
function pathInstructions(
	tree: RepositoryTree,
	path: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	const relative = path.slice(PATH_INSTRUCTIONS.length + 1);
	return (
		markdownAsset(
			tree,
			path,
			"instructions",
			problems,
			(data) => {
				const metadata: Metadata = flatFields(data, ["applyTo", "excludeAgent"]);
				const applyTo = globList(data.applyTo);
				if (applyTo.length > 0) setField(metadata, "applyTo", applyTo);
				const excluded = str(data.excludeAgent);
				if (excluded) setField(metadata, "excludeAgent", excluded);
				return {
					name: truncate(relative.slice(0, -".instructions.md".length), 200),
					description: str(data.description),
					metadata,
				};
			},
			{ lenient: true },
		)?.asset ?? null
	);
}

/** A prompt file, run as `/name` in chat. */
function promptFile(
	tree: RepositoryTree,
	path: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	const stem = path.slice(PROMPTS.length + 1, -".prompt.md".length);
	return (
		markdownAsset(
			tree,
			path,
			"prompt",
			problems,
			(data, body) => ({
				name: str(data.name) ?? stem,
				description: str(data.description) ?? firstLine(body),
				metadata: flatFields(data, ["name", "description"]),
			}),
			{ lenient: true },
		)?.asset ?? null
	);
}

/** A custom agent (or the older chat mode): its own instructions, tools and model. */
function customAgent(
	tree: RepositoryTree,
	path: string,
	extension: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	const file = basename(path);
	const stem = file.endsWith(".agent.md")
		? file.slice(0, -".agent.md".length)
		: file.slice(0, -extension.length);
	const result = markdownAsset(
		tree,
		path,
		"instructions",
		problems,
		(data) => {
			const metadata = flatFields(data, ["name", "description", "mcp-servers", "metadata"]);
			const servers = data["mcp-servers"];
			if (isPlainObject(servers)) setField(metadata, "mcpServers", Object.keys(servers).sort());
			return { name: str(data.name) ?? stem, description: str(data.description), metadata };
		},
		{ lenient: true },
	);
	if (!result) return null;
	const { asset, data } = result;
	// An agent's own MCP servers can carry credentials in their env and headers, so the stored
	// text has its front matter written again, redacted.
	if (data["mcp-servers"] === undefined) return asset;
	const body = (asset.files[0]?.content ?? "").replace(/^\uFEFF?---[\s\S]*?\n---[ \t]*\r?\n?/, "");
	const content = `---\n${stringify(redact(data))}---\n${body}`;
	return { ...asset, files: [{ path: basename(path), content }] };
}

/** `applyTo` is one comma-separated line of globs, or a list. */
function globList(value: unknown): string[] {
	const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return items.flatMap((item) =>
		typeof item === "string" && item.trim() !== "" ? [item.trim()] : [],
	);
}

export const copilot: Adapter = { runtime: "copilot", wants, detect };
