/**
 * Globs for files that no ripgrep reaches (`./file-store.ts`), read the way ripgrep's `--glob`
 * reads them, so a model writes one glob for either:
 *
 * - `*` is any run of characters in one part of a path, `?` any one of them, `[abc]`, `[a-z]` and
 *   `[!abc]` one of a set, and a backslash takes the next character as it is.
 * - `**` as a whole part is any number of parts, none included; at the end it is everything below.
 * - `{a,b}` is either. It may hold others, which ripgrep refuses; that is the one difference.
 * - A glob with no slash is matched against a file's name, in any directory. One with a slash is
 *   matched against the whole path from where the caller anchors it.
 * - The file itself has to match: a glob that names a directory does not take what is in it.
 * - Capitals and small letters differ.
 *
 * The glob is a model's, so no regular expression is made of it: a part is matched a character
 * at a time, going back to the last `*` only, and the parts with a table that visits each pair
 * of a glob's part and a path's part once.
 */

/** A glob read once, to match many paths. */
export interface Glob {
	/** Whether the path's parts from `start` on match. */
	matches(parts: readonly string[], start?: number): boolean;
}

/** A glob may branch into this many; `{a,b}{c,d}{e,f}` is eight. */
const MAX_ALTERNATIVES = 64;

type Token =
	| { kind: "char"; char: string }
	| { kind: "one" }
	| { kind: "run" }
	| { kind: "set"; negated: boolean; ranges: [string, string][] };

/** One part of a glob: `**`, or what a path's part has to match. */
type Part = "**" | Token[];

/** Reads a glob, or says in words why it cannot be read. */
export function readGlob(pattern: string): Glob | { error: string } {
	if (pattern.startsWith("!")) {
		return { error: "A glob that begins with ! leaves files out, which is not done here." };
	}
	const alternatives = expandBraces(pattern);
	if (alternatives === null) {
		return { error: `That glob branches into more than ${MAX_ALTERNATIVES}. Use fewer {…}.` };
	}
	const read = alternatives.map(readAlternative);
	return {
		matches: (parts, start = 0) => read.some((glob) => matchParts(glob, parts, start)),
	};
}

/** Whether the path matches the glob, for one path; `readGlob` reads the glob once for many. */
export function globMatches(pattern: string, path: string): boolean {
	const glob = readGlob(pattern);
	return !("error" in glob) && glob.matches(path.split("/"));
}

/**
 * Every glob the braces stand for, or null when there are too many. Braces with no comma stand
 * for what they hold, and one never closed is itself.
 */
function expandBraces(pattern: string): string[] | null {
	let open = -1;
	let depth = 0;
	let commas: number[] = [];
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern.charAt(index);
		if (char === "\\") {
			index++;
		} else if (char === "{") {
			if (depth === 0) {
				open = index;
				commas = [];
			}
			depth++;
		} else if (char === "," && depth === 1) {
			commas.push(index);
		} else if (char === "}" && depth > 0) {
			depth--;
			if (depth > 0) continue;
			const before = pattern.slice(0, open);
			const after = pattern.slice(index + 1);
			const cuts = [open, ...commas, index];
			const expanded: string[] = [];
			for (let cut = 0; cut + 1 < cuts.length; cut++) {
				const choice = pattern.slice((cuts[cut] ?? 0) + 1, cuts[cut + 1]);
				const further = expandBraces(`${before}${choice}${after}`);
				if (further === null) return null;
				expanded.push(...further);
				if (expanded.length > MAX_ALTERNATIVES) return null;
			}
			return expanded;
		}
	}
	return [pattern];
}

function readAlternative(pattern: string): Part[] {
	const anchored = pattern.startsWith("/");
	const parts = splitParts(anchored ? pattern.slice(1) : pattern).map(
		(part): Part => (part === "**" ? "**" : readPart(part)),
	);
	// With no slash it is a name, wherever the file is.
	return anchored || parts.length > 1 ? parts : ["**", ...parts];
}

/** The glob cut at its slashes, but not at one a backslash or a set holds. */
function splitParts(pattern: string): string[] {
	const parts: string[] = [];
	let part = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern.charAt(index);
		if (char === "\\" && index + 1 < pattern.length) {
			part += char + pattern.charAt(index + 1);
			index++;
		} else if (char === "/") {
			parts.push(part);
			part = "";
		} else {
			part += char;
		}
	}
	parts.push(part);
	return parts;
}

function readPart(part: string): Token[] {
	const tokens: Token[] = [];
	for (let index = 0; index < part.length; index++) {
		const char = part.charAt(index);
		if (char === "\\" && index + 1 < part.length) {
			tokens.push({ kind: "char", char: part.charAt(index + 1) });
			index++;
		} else if (char === "*") {
			// `a**b` is `a*b`: only a whole part of two stars crosses directories.
			if (tokens.at(-1)?.kind !== "run") tokens.push({ kind: "run" });
		} else if (char === "?") {
			tokens.push({ kind: "one" });
		} else if (char === "[") {
			const set = readSet(part, index);
			if (set) {
				tokens.push(set.token);
				index = set.end;
			} else {
				tokens.push({ kind: "char", char });
			}
		} else {
			tokens.push({ kind: "char", char });
		}
	}
	return tokens;
}

/** The set that opens at `open`, and where it closes; null when it never does. */
function readSet(part: string, open: number): { token: Token; end: number } | null {
	let index = open + 1;
	const negated = part.charAt(index) === "!" || part.charAt(index) === "^";
	if (negated) index++;
	const ranges: [string, string][] = [];
	// A `]` right after the opening is one of the set.
	for (let first = true; index < part.length; first = false) {
		const char = part.charAt(index);
		if (char === "]" && !first) return { token: { kind: "set", negated, ranges }, end: index };
		if (
			part.charAt(index + 1) === "-" &&
			index + 2 < part.length &&
			part.charAt(index + 2) !== "]"
		) {
			ranges.push([char, part.charAt(index + 2)]);
			index += 3;
		} else {
			ranges.push([char, char]);
			index++;
		}
	}
	return null;
}

function matchToken(token: Token, char: string): boolean {
	if (token.kind === "char") return token.char === char;
	if (token.kind === "set") {
		return token.ranges.some(([from, to]) => from <= char && char <= to) !== token.negated;
	}
	return true;
}

/** Whether a path's part matches a glob's: forward, and back to the last `*` when it fails. */
function matchPart(tokens: Token[], text: string): boolean {
	let token = 0;
	let char = 0;
	let star = -1;
	let starChar = 0;
	while (char < text.length) {
		const next = tokens[token];
		if (next && next.kind !== "run" && matchToken(next, text.charAt(char))) {
			token++;
			char++;
		} else if (next?.kind === "run") {
			star = token++;
			starChar = char;
		} else if (star !== -1) {
			token = star + 1;
			char = ++starChar;
		} else {
			return false;
		}
	}
	while (tokens[token]?.kind === "run") token++;
	return token === tokens.length;
}

function matchParts(glob: Part[], parts: readonly string[], start: number): boolean {
	const width = parts.length + 1;
	// 0 for not tried, 1 for no, 2 for yes: each pair of a glob's part and a path's is tried once.
	const tried = new Uint8Array((glob.length + 1) * width);
	const from = (at: number, part: number): boolean => {
		const key = at * width + part;
		if (tried[key] !== 0) return tried[key] === 2;
		const next = glob[at];
		let matched: boolean;
		if (next === undefined) {
			matched = part === parts.length;
		} else if (next === "**") {
			if (at === glob.length - 1) {
				// At the end it is what lies below, so something has to.
				matched = part < parts.length;
			} else {
				matched = false;
				for (let skipped = part; skipped <= parts.length && !matched; skipped++) {
					matched = from(at + 1, skipped);
				}
			}
		} else {
			const text = parts[part];
			matched = text !== undefined && matchPart(next, text) && from(at + 1, part + 1);
		}
		tried[key] = matched ? 2 : 1;
		return matched;
	};
	return from(0, start);
}
