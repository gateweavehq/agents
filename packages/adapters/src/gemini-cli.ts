/**
 * Gemini CLI. Docs, checked 2026-10-28:
 * - https://geminicli.com/docs/cli/gemini-md/ (GEMINI.md and `context.fileName`)
 * - https://geminicli.com/docs/reference/configuration/ (`.gemini/settings.json`, `mcpServers`)
 * - https://geminicli.com/docs/cli/custom-commands/ (`.gemini/commands/**.toml`)
 * - https://geminicli.com/docs/cli/skills/ (`.gemini/skills`, `.agents/skills`)
 *
 * The setting is `context.fileName` (a name or a list of names), not `contextFileName`. When it
 * is set it replaces the default `GEMINI.md`, so only the files it names are read.
 */
import type { DetectedAsset, Metadata, ScanProblem } from "@gateweave/agents-model";
import { addProblem, instructionsAsset, parseTomlConfig, readText, setField } from "./assets";
import { type ConfigFile, mcpServerAssets, readConfig, settingsAsset } from "./config";
import { Findings } from "./findings";
import { namesIn } from "./redaction";
import { skillAssets } from "./skills";
import type { Adapter, Detection, RepositoryTree } from "./types";
import {
	basename,
	compare,
	isEnvFile,
	isPlainObject,
	str,
	truncate,
	under,
	withoutExtension,
} from "./util";

const SETTINGS = ".gemini/settings.json";
const SKILL_ROOTS = [".gemini/skills", ".agents/skills"] as const;
const COMMANDS = ".gemini/commands";

function wants(path: string): boolean {
	if (basename(path) === "GEMINI.md" || path === SETTINGS) return true;
	if (path.startsWith(`${COMMANDS}/`) && path.endsWith(".toml")) return true;
	return SKILL_ROOTS.some((root) => under(path, root) !== null) && !isEnvFile(path);
}

/** The names `context.fileName` lists, or null when the setting is absent or unusable. */
function contextFileNames(settings: ConfigFile | null): string[] | null {
	const context = settings?.parsed.context;
	if (!isPlainObject(context)) return null;
	const raw = context.fileName;
	const names = (Array.isArray(raw) ? raw : [raw]).flatMap((name) => {
		const text = str(name);
		// A bare file name: Gemini searches for it in each directory.
		return text !== null && !text.includes("/") ? [text] : [];
	});
	return names.length > 0 ? names : null;
}

function detect(tree: RepositoryTree): Detection {
	const found = new Findings();
	const paths = [...tree.keys()].sort(compare);

	const settings = readConfig(tree, SETTINGS, "json", found.problems);
	const fileNames = contextFileNames(settings);
	const readNames = new Set(fileNames ?? ["GEMINI.md"]);
	let model: string | null = null;

	if (settings) {
		const modelSetting = settings.parsed.model;
		model = isPlainObject(modelSetting) ? str(modelSetting.name) : str(modelSetting);
		const extra: Metadata = {};
		if (fileNames) setField(extra, "contextFileName", fileNames);
		const servers = namesIn(settings.parsed.mcpServers);
		if (servers.length > 0) setField(extra, "mcpServers", servers);
		found.read(settingsAsset(settings, extra));
		found.readAll(mcpServerAssets(settings, settings.parsed.mcpServers, found.problems));
	}

	for (const path of paths) {
		const name = basename(path);
		if (name === "GEMINI.md" || readNames.has(name)) {
			// A custom name is not downloaded by the scanner, which cannot know it in advance.
			const asset = instructionsAsset(tree, path, found.problems, {
				optionalContent: name !== "GEMINI.md" && name !== "AGENTS.md",
			});
			if (!asset) continue;
			found.assets.push(asset);
			if (readNames.has(name)) found.reads.push(asset.key);
		} else if (path.startsWith(`${COMMANDS}/`) && path.endsWith(".toml")) {
			found.read(command(tree, path, found.problems));
		}
	}
	found.readAll(skillAssets(tree, SKILL_ROOTS, found.problems));

	// Only Gemini's own files make it an agent; a shared AGENTS.md alone does not.
	const detected = found.assets.some(
		(asset) => asset.kind !== "instructions" || basename(asset.path) === "GEMINI.md",
	);
	const agents = detected
		? [
				{
					runtime: "gemini-cli" as const,
					key: "main",
					name: "Gemini CLI",
					description: null,
					model: model === null ? null : truncate(model, 200),
					path: null,
					metadata: {},
					assets: [...new Set(found.reads)].sort(compare),
				},
			]
		: [];
	return { agents, assets: detected ? found.assets : [], problems: found.problems };
}

function command(
	tree: RepositoryTree,
	path: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	const text = readText(tree, path, problems);
	if (text === null) return null;
	const parsed = parseTomlConfig(text);
	if (!parsed.ok) {
		addProblem(problems, path, parsed.message);
		return null;
	}
	if (typeof parsed.value.prompt !== "string") {
		addProblem(problems, path, "The command has no prompt");
		return null;
	}
	const relative = path.slice(`${COMMANDS}/`.length);
	const description = str(parsed.value.description);
	return {
		kind: "prompt",
		key: path,
		// Subfolders namespace a command: `git/commit.toml` is `/git:commit`.
		name: truncate(withoutExtension(relative, ".toml").replaceAll("/", ":"), 200),
		description: description === null ? null : truncate(description, 2000),
		path,
		files: [{ path: basename(path), content: text }],
		metadata: {},
	};
}

export const geminiCli: Adapter = { runtime: "gemini-cli", wants, detect };
