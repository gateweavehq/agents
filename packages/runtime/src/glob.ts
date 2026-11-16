/**
 * Globs for files that no ripgrep reaches (`./file-store.ts`), read the way ripgrep's `--glob`
 * reads them, so a model writes one glob for either:
 *
 * - `*` is any run of characters in one part of a path, `?` any one of them, `[abc]`, `[a-z]` and
 *   `[!abc]` one of a set, and a backslash takes the next character as it is. A character is a
 *   code point, so `?` takes an emoji whole.
 * - `**` as a whole part is any number of parts, none included; at the end it is everything below.
 * - `{a,b}` is either. It may hold others, which ripgrep refuses; that is the one difference.
 * - A glob with no slash is matched against a file's name, in any directory. One with a slash is
 *   matched against the whole path from where the caller anchors it.
 * - The file itself has to match: a glob that names a directory does not take what is in it.
 * - Capitals and small letters differ.
 *
 * `test/ripgrep-recorded.test.ts` holds these to what the sandbox's ripgrep answered.
 *
 * The glob is a model's and it is matched in the conversation's Durable Object, against as many
 * as 20,000 paths, so the work one glob may do is bounded three ways. No regular expression is
 * made of it: a part is matched a character at a time, going back to the last `*` only, and the
 * parts with a table that visits each pair of a glob's part and a path's part once. A glob may
 * branch into `GLOB_LIMITS.alternatives`, hold `GLOB_LIMITS.parts` parts and
 * `GLOB_LIMITS.anyDepth` of them `**`, and is refused in words past that. And every step of the
 * matching is counted: past `GLOB_LIMITS.steps` over all the paths one glob is asked about,
 * `matches` throws `GlobTooSlow`, which the caller answers in words.
 */

export const GLOB_LIMITS = {
	/** What `{a,b}{c,d}` may branch into; that one is four. */
	alternatives: 64,
	/** Parts between slashes, in each alternative. */
	parts: 64,
	/** Parts that are `**`, in each alternative, after those in a row are taken as one. */
	anyDepth: 8,
	/**
	 * Steps one glob may take over every path it is asked about: a character compared, or a pair
	 * of parts tried. A plain glob over 20,000 paths takes under two million; twenty million is
	 * a fraction of a second.
	 */
	steps: 20_000_000,
};

/** A glob that was stopped, having taken more steps than one may. */
export class GlobTooSlow extends Error {
	constructor() {
		super("That glob takes too long to match against these files. Use a simpler one.");
		this.name = "GlobTooSlow";
	}
}

/** A glob read once, to match many paths. */
export interface Glob {
	/** Whether the path's parts from `start` on match. Throws `GlobTooSlow` past its steps. */
	matches(parts: readonly string[], start?: number): boolean;
	/** Whether it begins with `**` in every branch, so that where a path starts is all one. */
	readonly floating: boolean;
}

type Token =
	| { kind: "char"; char: string }
	| { kind: "one" }
	| { kind: "run" }
	| { kind: "set"; negated: boolean; ranges: [string, string][] };

/** One part of a glob: `**`, or what a path's part has to match. */
type Part = "**" | Token[];

/** Reads a glob, or says in words why it cannot be read. */
export function readGlob(
	pattern: string,
	steps: number = GLOB_LIMITS.steps,
): Glob | { error: string } {
	if (pattern.startsWith("!")) {
		return { error: "A glob that begins with ! leaves files out, which is not done here." };
	}
	const alternatives = expandBraces(pattern);
	if (alternatives === null) {
		return {
			error: `That glob branches into more than ${GLOB_LIMITS.alternatives}. Use fewer {…}.`,
		};
	}
	const read = alternatives.map(readAlternative);
	if (read.some((glob) => glob.length > GLOB_LIMITS.parts)) {
		return { error: `That glob has more than ${GLOB_LIMITS.parts} parts between its slashes.` };
	}
	if (read.some((glob) => glob.filter((part) => part === "**").length > GLOB_LIMITS.anyDepth)) {
		return { error: `That glob has more than ${GLOB_LIMITS.anyDepth} parts that are **.` };
	}
	const budget = { left: steps };
	return {
		floating: read.every((glob) => glob[0] === "**"),
		matches: (parts, start = 0) => read.some((glob) => matchParts(glob, parts, start, budget)),
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
				if (expanded.length > GLOB_LIMITS.alternatives) return null;
			}
			return expanded;
		}
	}
	return [pattern];
}

function readAlternative(pattern: string): Part[] {
	const anchored = pattern.startsWith("/");
	const parts: Part[] = [];
	for (const part of splitParts(anchored ? pattern.slice(1) : pattern)) {
		// `**/**` is `**`: any number of parts twice over is any number of parts.
		if (part === "**" && parts.at(-1) === "**") continue;
		parts.push(part === "**" ? "**" : readPart(part));
	}
	// With no slash it is a name, wherever the file is.
	if (anchored || parts.length > 1) return parts;
	return parts[0] === "**" ? parts : ["**", ...parts];
}

/** The glob cut at its slashes, but not at one a backslash holds. */
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
	// By code point, so that a character outside the first plane is one character.
	const chars = Array.from(part);
	const tokens: Token[] = [];
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index] ?? "";
		const next = chars[index + 1];
		if (char === "\\" && next !== undefined) {
			tokens.push({ kind: "char", char: next });
			index++;
		} else if (char === "*") {
			// `a**b` is `a*b`: only a whole part of two stars crosses directories.
			if (tokens.at(-1)?.kind !== "run") tokens.push({ kind: "run" });
		} else if (char === "?") {
			tokens.push({ kind: "one" });
		} else if (char === "[") {
			const set = readSet(chars, index);
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
function readSet(chars: readonly string[], open: number): { token: Token; end: number } | null {
	let index = open + 1;
	const negated = chars[index] === "!" || chars[index] === "^";
	if (negated) index++;
	const ranges: [string, string][] = [];
	// A `]` right after the opening is one of the set.
	for (let first = true; index < chars.length; first = false) {
		const char = chars[index] ?? "";
		if (char === "]" && !first) return { token: { kind: "set", negated, ranges }, end: index };
		const to = chars[index + 2];
		if (chars[index + 1] === "-" && to !== undefined && to !== "]") {
			ranges.push([char, to]);
			index += 3;
		} else {
			ranges.push([char, char]);
			index++;
		}
	}
	return null;
}

/** Where a character stands among all characters: `<` on strings compares halves of a pair. */
function order(char: string): number {
	return char.codePointAt(0) ?? 0;
}

function matchToken(token: Token, char: string): boolean {
	if (token.kind === "char") return token.char === char;
	if (token.kind === "set") {
		const at = order(char);
		return (
			token.ranges.some(([from, to]) => order(from) <= at && at <= order(to)) !== token.negated
		);
	}
	return true;
}

interface Budget {
	left: number;
}

function spend(budget: Budget): void {
	if (--budget.left < 0) throw new GlobTooSlow();
}

/** Whether the text holds half of a pair, and so has to be taken a code point at a time. */
function hasPairs(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdfff) return true;
	}
	return false;
}

/** Whether a path's part matches a glob's: forward, and back to the last `*` when it fails. */
function matchPart(tokens: Token[], part: string, budget: Budget): boolean {
	const text: ArrayLike<string> = hasPairs(part) ? Array.from(part) : part;
	let token = 0;
	let char = 0;
	let star = -1;
	let starChar = 0;
	while (char < text.length) {
		spend(budget);
		const next = tokens[token];
		if (next && next.kind !== "run" && matchToken(next, text[char] ?? "")) {
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

function matchParts(
	glob: Part[],
	parts: readonly string[],
	start: number,
	budget: Budget,
): boolean {
	const width = parts.length + 1;
	// 0 for not tried, 1 for no, 2 for yes: each pair of a glob's part and a path's is tried once.
	const tried = new Uint8Array((glob.length + 1) * width);
	const lastAny = glob.lastIndexOf("**");
	const from = (at: number, part: number): boolean => {
		const key = at * width + part;
		if (tried[key] !== 0) return tried[key] === 2;
		spend(budget);
		const next = glob[at];
		let matched: boolean;
		if (next === undefined) {
			matched = part === parts.length;
		} else if (next === "**") {
			if (at === glob.length - 1) {
				// At the end it is what lies below, so something has to.
				matched = part < parts.length;
			} else if (at === lastAny) {
				// No `**` follows, so what follows takes one part of the path each, and they are
				// the path's last: `**/*.ts` looks at a file's name and nowhere else.
				const rest = parts.length - (glob.length - at - 1);
				matched = rest >= part && from(at + 1, rest);
			} else {
				matched = false;
				for (let skipped = part; skipped <= parts.length && !matched; skipped++) {
					matched = from(at + 1, skipped);
				}
			}
		} else {
			const text = parts[part];
			matched = text !== undefined && matchPart(next, text, budget) && from(at + 1, part + 1);
		}
		tried[key] = matched ? 2 : 1;
		return matched;
	};
	return from(0, start);
}
