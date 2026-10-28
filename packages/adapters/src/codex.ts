/**
 * Codex. Docs, checked 2026-10-28:
 * - https://developers.openai.com/codex/guides/agents-md (now https://learn.chatgpt.com/docs/agent-configuration/agents-md)
 * - https://learn.chatgpt.com/docs/config-file/config-basic (project `.codex/config.toml`)
 * - https://learn.chatgpt.com/docs/extend/mcp (`[mcp_servers.<name>]`)
 * - https://learn.chatgpt.com/docs/build-skills (`.agents/skills`)
 *
 * Codex reads `AGENTS.md` (or `AGENTS.override.md`) in every directory from the repository
 * root down. `project_doc_fallback_filenames` is a user-level setting, so it is not read here.
 */
import type { Metadata } from "@gateweave/agents-model";
import { instructionsAsset, setField } from "./assets";
import { type ConfigFile, mcpServerAssets, readConfig, settingsAsset } from "./config";
import { Findings } from "./findings";
import { namesIn } from "./redaction";
import { skillAssets } from "./skills";
import type { Adapter, Detection, RepositoryTree } from "./types";
import { basename, compare, dirname, isEnvFile, isPlainObject, str, truncate, under } from "./util";

export const CODEX_SKILL_ROOTS = [".agents/skills"] as const;

function isInstructionsFile(path: string): boolean {
	const name = basename(path);
	return name === "AGENTS.md" || name === "AGENTS.override.md";
}

function isConfig(path: string): boolean {
	return basename(path) === "config.toml" && basename(dirname(path)) === ".codex";
}

function wants(path: string): boolean {
	if (isInstructionsFile(path) || isConfig(path)) return true;
	return under(path, ".agents/skills") !== null && !isEnvFile(path);
}

function detect(tree: RepositoryTree): Detection {
	const found = new Findings();
	const paths = [...tree.keys()].sort(compare);
	let model: string | null = null;

	for (const path of paths) {
		if (isInstructionsFile(path)) found.read(instructionsAsset(tree, path, found.problems));
		if (isConfig(path)) {
			const config = readConfig(tree, path, "toml", found.problems);
			if (!config) continue;
			if (path === ".codex/config.toml") model = str(config.parsed.model);
			found.read(settingsAsset(config, serverNames(config)));
			found.readAll(mcpServerAssets(config, config.parsed.mcp_servers, found.problems));
		}
	}
	found.readAll(skillAssets(tree, CODEX_SKILL_ROOTS, found.problems));

	const agents =
		found.reads.length === 0
			? []
			: [
					{
						runtime: "codex" as const,
						key: "main",
						name: "Codex",
						description: null,
						model: model === null ? null : truncate(model, 200),
						path: null,
						metadata: {},
						assets: [...new Set(found.reads)].sort(compare),
					},
				];
	return { agents, assets: found.assets, problems: found.problems };
}

/** The names of the configured MCP servers, which the settings asset lists beside its scalars. */
function serverNames(config: ConfigFile): Metadata {
	const names = isPlainObject(config.parsed.mcp_servers) ? namesIn(config.parsed.mcp_servers) : [];
	const extra: Metadata = {};
	if (names.length > 0) setField(extra, "mcp_servers", names);
	return extra;
}

export const codex: Adapter = { runtime: "codex", wants, detect };
