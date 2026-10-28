/** Builders for the pieces every adapter makes: problems, text files, directories and metadata. */
import {
	type DetectedAsset,
	MAX_FILE_LENGTH,
	type Metadata,
	type ScannedFile,
	type ScanProblem,
} from "@gateweave/agents-model";
import { parse as parseToml } from "smol-toml";
import { canonicalJson, canonicalToml, redact } from "./redaction";
import type { RepositoryTree } from "./types";
import { basename, compare, isEnvFile, isPlainObject, messageOf, truncate } from "./util";

const MAX_FIELDS = 50;
const MAX_FILES = 500;

export function addProblem(problems: ScanProblem[], path: string, message: string): void {
	problems.push({ path, message: truncate(message, 500) });
}

/** The text of a file, or null with a problem when the scanner did not bring it. */
export function readText(
	tree: RepositoryTree,
	path: string,
	problems: ScanProblem[],
): string | null {
	const content = tree.get(path)?.content;
	if (content === undefined || content.length > MAX_FILE_LENGTH) {
		addProblem(problems, path, "The file's text was not available");
		return null;
	}
	return content;
}

/**
 * Fields for showing and searching, copied from parsed front matter, JSON or TOML: text,
 * numbers, booleans and lists of text. Nested values are left in the file.
 */
export function flatFields(
	source: Record<string, unknown>,
	skip: readonly string[] = [],
): Metadata {
	const fields: Metadata = {};
	for (const [key, value] of Object.entries(source)) {
		if (Object.keys(fields).length >= MAX_FIELDS) break;
		// Assigning `__proto__` would replace the object's prototype instead of adding a field.
		if (skip.includes(key) || key === "" || key.length > 100 || key === "__proto__") continue;
		const flat = flatValue(value);
		if (flat !== undefined) fields[key] = flat;
	}
	return fields;
}

function flatValue(value: unknown): Metadata[string] | undefined {
	if (typeof value === "string") return truncate(value, 2000);
	if (typeof value === "boolean" || value === null) return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const items: string[] = [];
		for (const item of value) {
			if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
				items.push(truncate(String(item), 500));
			} else {
				return undefined;
			}
		}
		return items.slice(0, 200);
	}
	return undefined;
}

/** Sets a field unless the 50-field limit is reached, so the extra names never make a scan fail. */
export function setField(metadata: Metadata, key: string, value: Metadata[string]): void {
	if (key in metadata || Object.keys(metadata).length < MAX_FIELDS) metadata[key] = value;
}

/** Text for the file's own path, as `AGENTS.md` or `CLAUDE.md`: stored byte for byte. */
export function instructionsAsset(
	tree: RepositoryTree,
	path: string,
	problems: ScanProblem[],
	options: { optionalContent?: boolean } = {},
): DetectedAsset | null {
	const file = tree.get(path);
	if (!file) return null;
	const name = basename(path);
	const base = {
		kind: "instructions",
		key: path,
		name: truncate(path, 200),
		description: null,
		path,
		metadata: {},
	} as const;
	if (file.content === undefined && options.optionalContent) {
		return { ...base, files: [{ path: name, blob: file.blob, size: file.size }] };
	}
	const content = readText(tree, path, problems);
	return content === null ? null : { ...base, files: [{ path: name, content }] };
}

/**
 * Every file under a directory ("" is the repository root), in path order, or only those
 * `options.include` accepts. Files without text are given by blob and size. `problemPath` names
 * the directory in a problem when it is "".
 */
export function directoryFiles(
	tree: RepositoryTree,
	directory: string,
	problems: ScanProblem[],
	render?: (relativePath: string, content: string) => string | null,
	options: { include?: (relativePath: string) => boolean; problemPath?: string } = {},
): ScannedFile[] {
	const prefix = directory === "" ? "" : `${directory}/`;
	const paths = [...tree.keys()]
		.filter(
			(path) =>
				path.startsWith(prefix) && (!options.include || options.include(path.slice(prefix.length))),
		)
		.sort(compare);
	if (paths.length > MAX_FILES) {
		addProblem(
			problems,
			options.problemPath ?? directory,
			`Only the first ${MAX_FILES} of ${paths.length} files are kept`,
		);
	}
	const files: ScannedFile[] = [];
	for (const path of paths.slice(0, MAX_FILES)) {
		const file = tree.get(path);
		if (!file) continue;
		const relative = path.slice(prefix.length);
		const content = file.content;
		const rendered =
			content === undefined || content.length > MAX_FILE_LENGTH || isEnvFile(path)
				? null
				: render
					? render(relative, content)
					: content;
		files.push(
			rendered === null
				? { path: relative, blob: file.blob, size: file.size }
				: { path: relative, content: rendered },
		);
	}
	return files;
}

export type ParsedConfig =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; message: string };

export function parseJsonConfig(text: string): ParsedConfig {
	try {
		const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
		return isPlainObject(value) ? { ok: true, value } : { ok: false, message: "Not a JSON object" };
	} catch (error) {
		return { ok: false, message: `Not valid JSON: ${messageOf(error)}` };
	}
}

export function parseTomlConfig(text: string): ParsedConfig {
	try {
		return { ok: true, value: parseToml(text) };
	} catch (error) {
		return { ok: false, message: `Not valid TOML: ${messageOf(error)}` };
	}
}

/** The redacted, canonical text of a configuration file, as it is stored. */
export function redactedText(value: Record<string, unknown>, format: "json" | "toml"): string {
	const safe = redact(value);
	if (!isPlainObject(safe)) return canonicalJson(safe);
	return format === "json" ? canonicalJson(safe) : canonicalToml(safe);
}
