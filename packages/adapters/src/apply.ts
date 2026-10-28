/**
 * Decides how the files `writeAssets` produced land in a repository: which are new content,
 * which already say the same, and which must be left alone. Pure, so the Worker (which opens the
 * pull request) and a CLI plan the same way.
 *
 * A setup owns the files it writes. The MCP configuration files are the exception: they hold
 * other servers and, for Gemini and Codex, the agent's other settings, so only the setup's own
 * servers (by name) are merged in and everything else is left as the repository has it.
 */
import { parse as parseToml } from "smol-toml";
import { compare, isPlainObject } from "./util";
import type { WrittenFile } from "./write";

/** A file in the repository's tree at the commit the setup is applied to. A symlink's blob holds its target. */
export interface RepositoryEntry {
	path: string;
	symlink: boolean;
}

export interface ApplyPlanInput {
	/** What `writeAssets` produced. */
	files: readonly WrittenFile[];
	/** Every file in the repository's tree (blobs and symlinks; folders are implied by paths). */
	tree: readonly RepositoryEntry[];
	/**
	 * The current text of each path in `files` that exists in `tree`, by path. Null when the text
	 * could not be read (binary, too large). A missing key means the same as null.
	 */
	texts: ReadonlyMap<string, string | null>;
}

export interface ApplyProblem {
	path: string;
	message: string;
}

export interface ApplyPlan {
	/** Files to write, each with its whole new content, sorted by path. */
	changes: WrittenFile[];
	/** Paths the setup writes that already say what it would write, sorted. */
	unchanged: string[];
	/** Paths the setup writes that were left alone, and why, sorted by path. */
	problems: ApplyProblem[];
}

/**
 * Configuration files a setup shares with the rest of the repository: only its servers are merged
 * in. They are the paths `write-mcp.ts` writes; the writer owns those as whole files, but in a
 * repository they usually hold more.
 */
export const MERGED_FILES: ReadonlySet<string> = new Set([
	".mcp.json",
	".cursor/mcp.json",
	".gemini/settings.json",
	".codex/config.toml",
]);

type Outcome =
	| { kind: "change"; content: string }
	| { kind: "unchanged" }
	| { kind: "problem"; message: string };

const CHANGE = (content: string): Outcome => ({ kind: "change", content });
const UNCHANGED: Outcome = { kind: "unchanged" };
const PROBLEM = (message: string): Outcome => ({ kind: "problem", message });

export function planApply(input: ApplyPlanInput): ApplyPlan {
	const entries = new Map(input.tree.map((entry) => [entry.path, entry.symlink]));
	const folders = new Set<string>();
	for (const entry of input.tree) {
		for (
			let slash = entry.path.indexOf("/");
			slash !== -1;
			slash = entry.path.indexOf("/", slash + 1)
		) {
			folders.add(entry.path.slice(0, slash));
		}
	}

	const plan: ApplyPlan = { changes: [], unchanged: [], problems: [] };
	const seen = new Set<string>();
	for (const file of [...input.files].sort((a, b) => compare(a.path, b.path))) {
		if (seen.has(file.path)) continue;
		seen.add(file.path);
		const outcome =
			blocked(file.path, entries, folders) ??
			(MERGED_FILES.has(file.path)
				? mergeFile(file, entries.has(file.path), input.texts.get(file.path) ?? null)
				: ownFile(file, entries.has(file.path), input.texts.get(file.path) ?? null));
		if (outcome.kind === "change") plan.changes.push({ path: file.path, content: outcome.content });
		else if (outcome.kind === "unchanged") plan.unchanged.push(file.path);
		else plan.problems.push({ path: file.path, message: outcome.message });
	}
	return plan;
}

/** Something that is not a plain file is in the way: a symlink, a file where a folder must be, or a folder. */
function blocked(
	path: string,
	entries: ReadonlyMap<string, boolean>,
	folders: ReadonlySet<string>,
): Outcome | null {
	if (entries.get(path) === true) return PROBLEM("Is a symbolic link in the repository");
	for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
		const parent = path.slice(0, slash);
		const symlink = entries.get(parent);
		if (symlink !== undefined) {
			return PROBLEM(
				`${parent} is ${symlink ? "a symbolic link" : "a file"} in the repository, so ${path} cannot be written below it`,
			);
		}
	}
	if (folders.has(path)) return PROBLEM("Is a folder in the repository");
	return null;
}

function ownFile(file: WrittenFile, exists: boolean, text: string | null): Outcome {
	return exists && text === file.content ? UNCHANGED : CHANGE(file.content);
}

function mergeFile(file: WrittenFile, exists: boolean, text: string | null): Outcome {
	if (!exists) return CHANGE(file.content);
	if (text === null) return PROBLEM("Could not be read, so the servers could not be merged");
	return file.path.endsWith(".toml") ? mergeToml(file, text) : mergeJson(file, text);
}

// JSON

function parseJson(text: string): unknown {
	return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function mergeJson(file: WrittenFile, text: string): Outcome {
	let setup: Record<string, unknown>;
	try {
		const parsed = parseJson(file.content);
		const servers = isPlainObject(parsed) ? parsed.mcpServers : undefined;
		if (!isPlainObject(servers)) return PROBLEM("The setup's file has no mcpServers to merge");
		setup = servers;
	} catch {
		return PROBLEM("The setup's file is not valid JSON");
	}

	let existing: unknown;
	try {
		existing = parseJson(text);
	} catch {
		return PROBLEM("Is not plain JSON, so the servers could not be merged");
	}
	if (!isPlainObject(existing))
		return PROBLEM("Is not a JSON object, so the servers could not be merged");
	const current = existing.mcpServers;
	if (current !== undefined && !isPlainObject(current))
		return PROBLEM("Has an mcpServers that is not an object, so the servers could not be merged");

	const known = current ?? {};
	if (
		Object.entries(setup).every(
			([name, server]) => Object.hasOwn(known, name) && deepEqual(known[name], server),
		)
	) {
		return UNCHANGED;
	}

	const servers: [string, unknown][] = Object.entries(known).map(([name, server]) => [
		name,
		Object.hasOwn(setup, name) && !deepEqual(server, setup[name]) ? setup[name] : server,
	]);
	for (const [name, server] of Object.entries(setup))
		if (!Object.hasOwn(known, name)) servers.push([name, server]);
	const merged: [string, unknown][] = Object.entries(existing).map(([key, value]) =>
		key === "mcpServers" ? [key, Object.fromEntries(servers)] : [key, value],
	);
	if (current === undefined) merged.push(["mcpServers", Object.fromEntries(servers)]);

	const content = `${JSON.stringify(Object.fromEntries(merged), null, indentOf(text))}\n`;
	return content === text ? UNCHANGED : CHANGE(content);
}

/** A tab or N spaces, from the first indented line; 2 spaces when nothing is indented. */
function indentOf(text: string): string {
	const found = /^([ \t]+)\S/m.exec(text);
	const indent = found?.[1];
	if (!indent) return "  ";
	return indent.startsWith("\t") ? "\t" : " ".repeat(indent.length);
}

// TOML

function mergeToml(file: WrittenFile, text: string): Outcome {
	let setup: Record<string, unknown>;
	try {
		const servers = parseToml(file.content).mcp_servers;
		if (!isPlainObject(servers)) return PROBLEM("The setup's file has no mcp_servers to merge");
		setup = servers;
	} catch {
		return PROBLEM("The setup's file is not valid TOML");
	}

	let existing: Record<string, unknown>;
	try {
		existing = parseToml(text);
	} catch {
		return PROBLEM("Is not valid TOML, so the servers could not be merged");
	}
	const current = existing.mcp_servers;
	if (current !== undefined && !isPlainObject(current))
		return PROBLEM("Has an mcp_servers that is not a table, so the servers could not be merged");

	const known = current ?? {};
	if (
		Object.entries(setup).every(
			([name, server]) => Object.hasOwn(known, name) && deepEqual(known[name], server),
		)
	) {
		return UNCHANGED;
	}

	const names = new Set(Object.keys(setup));
	const kept = withoutTables(text, names).replace(/\n+$/, "");
	const addition = file.content.endsWith("\n") ? file.content : `${file.content}\n`;
	const content =
		kept.trim() === "" ? addition : `${kept}${kept.endsWith("\n") ? "" : "\n"}\n${addition}`;

	// Editing text by lines can be fooled (a header-like line in a multi-line string, a server
	// written as an inline table or with dotted keys), so the result is parsed again and must be
	// the original plus exactly the setup's servers.
	const unsafe = PROBLEM(
		"Defines its servers in a way that cannot be merged safely; change it by hand",
	);
	let result: Record<string, unknown>;
	try {
		result = parseToml(content);
	} catch {
		return unsafe;
	}
	const servers = result.mcp_servers;
	if (!isPlainObject(servers)) return unsafe;
	for (const [name, server] of Object.entries(setup)) {
		if (!deepEqual(servers[name], server)) return unsafe;
	}
	if (!deepEqual(without(result, names), without(existing, names))) return unsafe;
	return content === text ? UNCHANGED : CHANGE(content);
}

/** The document without the named servers (and without an `mcp_servers` they leave empty). */
function without(document: Record<string, unknown>, names: ReadonlySet<string>): unknown {
	const servers = document.mcp_servers;
	if (!isPlainObject(servers)) return document;
	const rest = Object.fromEntries(Object.entries(servers).filter(([name]) => !names.has(name)));
	const { mcp_servers: _, ...others } = document;
	return Object.keys(rest).length > 0 ? { ...others, mcp_servers: rest } : others;
}

/**
 * Drops every table `mcp_servers.<name>` and below, for the given names. A table runs from its
 * header to the next header. Comments directly above the next header stay with it.
 */
function withoutTables(text: string, names: ReadonlySet<string>): string {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const out: string[] = [];
	let removing = false;
	let pending: string[] = [];
	for (const line of lines) {
		const key = headerKey(line);
		if (key === null) {
			if (!removing) out.push(line);
			else if (/^\s*#/.test(line)) pending.push(line);
			else pending = [];
			continue;
		}
		if (removing) out.push(...pending);
		pending = [];
		removing = key[0] === "mcp_servers" && key.length >= 2 && names.has(key[1] ?? "");
		if (!removing) out.push(line);
	}
	return out.join("");
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = {
	b: "\b",
	t: "\t",
	n: "\n",
	f: "\f",
	r: "\r",
	'"': '"',
	"\\": "\\",
};

/** The key path of a `[table]` or `[[array]]` header line, or null if the line is not one. */
function headerKey(line: string): string[] | null {
	const text = line.replace(/\r?\n$/, "");
	let at = 0;
	const skip = () => {
		while (text[at] === " " || text[at] === "\t") at += 1;
	};
	skip();
	if (text[at] !== "[") return null;
	const array = text[at + 1] === "[";
	at += array ? 2 : 1;
	const keys: string[] = [];
	for (;;) {
		skip();
		const key = readKey(text, at);
		if (key === null) return null;
		keys.push(key.value);
		at = key.end;
		skip();
		if (text[at] === ".") {
			at += 1;
			continue;
		}
		break;
	}
	if (text[at] !== "]") return null;
	at += 1;
	if (array) {
		if (text[at] !== "]") return null;
		at += 1;
	}
	skip();
	return at >= text.length || text[at] === "#" ? keys : null;
}

function readKey(text: string, start: number): { value: string; end: number } | null {
	const first = text[start];
	if (first === "'") {
		const close = text.indexOf("'", start + 1);
		return close === -1 ? null : { value: text.slice(start + 1, close), end: close + 1 };
	}
	if (first === '"') {
		let value = "";
		for (let at = start + 1; at < text.length; at += 1) {
			const char = text[at];
			if (char === '"') return { value, end: at + 1 };
			if (char !== "\\") {
				value += char;
				continue;
			}
			const next = text[at + 1];
			if (next === undefined) return null;
			if (next === "u" || next === "U") {
				const length = next === "u" ? 4 : 8;
				const hex = text.slice(at + 2, at + 2 + length);
				const code = Number.parseInt(hex, 16);
				if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex) || code > 0x10ffff) return null;
				value += String.fromCodePoint(code);
				at += 1 + length;
				continue;
			}
			const escaped = ESCAPES[next];
			if (escaped === undefined) return null;
			value += escaped;
			at += 1;
		}
		return null;
	}
	let end = start;
	while (end < text.length && BARE_KEY.test(text[end] ?? "")) end += 1;
	return end === start ? null : { value: text.slice(start, end), end };
}

/** Structural equality, whatever the key order. Dates compare by instant. */
function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => deepEqual(item, b[index]))
		);
	}
	if (a instanceof Date || b instanceof Date) {
		return (
			a instanceof Date &&
			b instanceof Date &&
			a.constructor === b.constructor &&
			a.toISOString() === b.toISOString()
		);
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
		);
	}
	return false;
}
