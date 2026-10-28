/** A settings file and the MCP servers inside a configuration file, both stored redacted. */
import type { DetectedAsset, Metadata, ScanProblem } from "@gateweave/agents-model";
import {
	addProblem,
	flatFields,
	parseJsonConfig,
	parseTomlConfig,
	readText,
	redactedText,
	setField,
} from "./assets";
import { namesIn, redact } from "./redaction";
import type { RepositoryTree } from "./types";
import { basename, isPlainObject, str, truncate } from "./util";

export type ConfigFormat = "json" | "toml";

export interface ConfigFile {
	path: string;
	format: ConfigFormat;
	/** The parsed file, secrets included. Only `settings` and `servers` may leave this module. */
	parsed: Record<string, unknown>;
}

/** Reads and parses a configuration file, reporting a problem instead of throwing. */
export function readConfig(
	tree: RepositoryTree,
	path: string,
	format: ConfigFormat,
	problems: ScanProblem[],
): ConfigFile | null {
	if (!tree.has(path)) return null;
	const text = readText(tree, path, problems);
	if (text === null) return null;
	const result = format === "json" ? parseJsonConfig(text) : parseTomlConfig(text);
	if (!result.ok) {
		addProblem(problems, path, result.message);
		return null;
	}
	return { path, format, parsed: result.value };
}

/** The file as a `settings` asset. `extra` adds metadata computed from the parsed file. */
export function settingsAsset(config: ConfigFile, extra: Metadata = {}): DetectedAsset {
	const safe = redact(config.parsed);
	const redactedFields = isPlainObject(safe) ? safe : {};
	const metadata = flatFields(redactedFields);
	for (const [key, value] of Object.entries(extra)) setField(metadata, key, value);
	const env = namesIn(config.parsed.env);
	if (env.length > 0) setField(metadata, "env", env);
	return {
		kind: "settings",
		key: config.path,
		name: truncate(config.path, 200),
		description: null,
		path: config.path,
		files: [{ path: basename(config.path), content: redactedText(config.parsed, config.format) }],
		metadata,
	};
}

/** Keys whose values are request headers or their sources: only the names are kept. */
const HEADER_KEYS = ["headers", "http_headers", "env_http_headers"] as const;
const NAMES_ONLY = new Set(["env", ...HEADER_KEYS]);

/**
 * One `mcp-server` asset per entry of `servers`, keyed `file#name`. The asset holds the server's
 * own redacted text under the file's name; its metadata has the names of env variables and
 * headers, never their values.
 */
export function mcpServerAssets(
	config: ConfigFile,
	servers: unknown,
	problems: ScanProblem[],
): DetectedAsset[] {
	if (servers === undefined) return [];
	if (!isPlainObject(servers)) {
		addProblem(problems, config.path, "The MCP servers are not a table of named servers");
		return [];
	}
	const assets: DetectedAsset[] = [];
	for (const [name, server] of Object.entries(servers)) {
		if (!isPlainObject(server)) {
			addProblem(problems, config.path, `The MCP server "${truncate(name, 100)}" is not a table`);
			continue;
		}
		const safe = redact(server);
		const safeServer = isPlainObject(safe) ? safe : {};
		const metadata = flatFields(safeServer, [...NAMES_ONLY, "description"]);
		if (metadata.type === undefined) {
			if (typeof server.httpUrl === "string") metadata.type = "http";
			else if (typeof server.command === "string") metadata.type = "stdio";
		}
		const env = namesIn(server.env);
		if (env.length > 0) setField(metadata, "env", env);
		const headers = HEADER_KEYS.flatMap((key) => namesIn(server[key]));
		if (headers.length > 0) setField(metadata, "headers", [...new Set(headers)].sort());
		const description = str(server.description);
		assets.push({
			kind: "mcp-server",
			key: `${config.path}#${name}`,
			name: truncate(name, 200),
			description: description === null ? null : truncate(description, 2000),
			path: config.path,
			files: [{ path: basename(config.path), content: redactedText(server, config.format) }],
			metadata,
		});
	}
	return assets;
}
