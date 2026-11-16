/**
 * Globs for files that no ripgrep reaches (`./file-store.ts`), read the way ripgrep's `--glob`
 * reads them, so a model writes one glob for either. The rules are what the sandbox image's
 * ripgrep was recorded doing (`test/ripgrep/recorded.json`), and `test/ripgrep-recorded.test.ts`
 * holds this module to the recordings:
 *
 * - `*` is any run within one part of a path, `?` any one byte of it, `[abc]`, `[a-z]` and
 *   `[!abc]` one byte of a set, and a backslash takes what follows as it is.
 * - **A name is matched as its UTF-8 bytes**, as ripgrep matches it. For names in ASCII that is
 *   a character; for others it is not: `?.txt` does not take `é.txt`, `??.txt` does, and a set
 *   holds bytes, so `[é]` is two of them and takes neither `é` nor any other letter. A letter
 *   written out in a glob still takes that letter: `é*.txt` takes `é.txt`.
 * - `**` as a whole part is any number of parts, none included; at the end it is everything below.
 * - `{a,b}` is either. Braces inside a set are bytes of the set, not branches. Braces may hold
 *   others, which ripgrep refuses; that is the one thing taken here that ripgrep does not take.
 * - A glob with no slash anywhere is matched against a file's name, in any directory. One with a
 *   slash, in any of its branches, is matched in every branch against the whole path from where
 *   the caller anchors it: `{src/a.ts,README.md}` takes a `README.md` only where the path starts.
 * - The file itself has to match: a glob that names a directory does not take what is in it.
 * - Capitals and small letters differ.
 *
 * The glob is a model's and it is matched in the conversation's Durable Object, against as many
 * as 20,000 paths, so the work one glob may do is bounded. No regular expression is made of it:
 * a part is matched a byte at a time, going back to the last `*` only; a set is a table looked
 * up once a byte, however long the set is written; and the parts are matched with a table that
 * works each pair of a glob's part and a path's part out once. A glob may branch into
 * `GLOB_LIMITS.alternatives`, hold `GLOB_LIMITS.parts` parts and `GLOB_LIMITS.anyDepth` of them
 * `**`, and is refused in words past that. And every step is counted, a byte compared or a pair
 * of parts looked at, whether worked out or remembered: past `GLOB_LIMITS.steps` over all the
 * paths one glob is asked about, `matches` throws `GlobTooSlow`, which the caller answers in
 * words.
 */

export const GLOB_LIMITS = {
	/** What `{a,b}{c,d}` may branch into; that one is four. */
	alternatives: 64,
	/** Parts between slashes, in each alternative. */
	parts: 64,
	/** Parts that are `**`, in each alternative, after those in a row are taken as one. */
	anyDepth: 8,
	/**
	 * Steps one glob may take over every path it is asked about: a byte compared, or a pair of
	 * parts looked at. `test/glob.test.ts` holds the figures: plain globs over 20,000 paths stay
	 * under half of this, and globs made to be slow are stopped by it.
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
	/** Steps taken so far, of those it may take. */
	readonly steps: number;
}

type Token =
	| { kind: "byte"; byte: number }
	| { kind: "one" }
	| { kind: "run" }
	/** A set, as a table of the 256 bytes: 1 for those it takes. */
	| { kind: "set"; takes: Uint8Array };

/** One part of a glob: `**`, or what a path's part has to match. */
type Part = "**" | Token[];

const BACKSLASH = 0x5c;
const STAR = 0x2a;
const QUESTION = 0x3f;
const OPEN = 0x5b;
const CLOSE = 0x5d;
const BANG = 0x21;
const CARET = 0x5e;
const DASH = 0x2d;

const encoder = new TextEncoder();

/** Reads a glob, or says in words why it cannot be read. */
export function readGlob(
	pattern: string,
	steps: number = GLOB_LIMITS.steps,
): Glob | { error: string } {
	if (pattern.startsWith("!")) {
		return { error: "A glob that begins with ! leaves files out, which is not done here." };
	}
	// Decided for the glob whole, before its branches are told apart, as ripgrep decides it.
	const anchored = pattern.includes("/");
	const alternatives = expandBraces(pattern.startsWith("/") ? pattern.slice(1) : pattern);
	if (alternatives === null) {
		return {
			error: `That glob branches into more than ${GLOB_LIMITS.alternatives}. Use fewer {…}.`,
		};
	}
	const read = alternatives.map((alternative) => readAlternative(alternative, anchored));
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
		get steps() {
			return steps - Math.max(budget.left, 0);
		},
	};
}

/** Whether the path matches the glob, for one path; `readGlob` reads the glob once for many. */
export function globMatches(pattern: string, path: string): boolean {
	const glob = readGlob(pattern);
	return !("error" in glob) && glob.matches(path.split("/"));
}

/**
 * Where the set that opens at `open` closes, or -1 when it never does. A `]` right after the
 * opening, or after the `!` or `^` that turns the set round, is one of the set.
 */
function setEnd(pattern: string, open: number): number {
	let index = open + 1;
	if (pattern.charAt(index) === "!" || pattern.charAt(index) === "^") index++;
	for (let first = true; index < pattern.length; index++, first = false) {
		if (pattern.charAt(index) === "]" && !first) return index;
	}
	return -1;
}

/**
 * Every glob the braces stand for, or null when there are too many. Braces with no comma stand
 * for what they hold, one never closed is itself, and braces inside a set are the set's.
 */
function expandBraces(pattern: string): string[] | null {
	let open = -1;
	let depth = 0;
	let commas: number[] = [];
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern.charAt(index);
		if (char === "\\") {
			index++;
		} else if (char === "[") {
			const end = setEnd(pattern, index);
			if (end !== -1) index = end;
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

function readAlternative(pattern: string, anchored: boolean): Part[] {
	const parts: Part[] = [];
	for (const part of splitParts(pattern)) {
		// `**/**` is `**`: any number of parts twice over is any number of parts.
		if (part === "**" && parts.at(-1) === "**") continue;
		parts.push(part === "**" ? "**" : readPart(part));
	}
	// With no slash in the glob it is a name, wherever the file is.
	if (anchored) return parts;
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
	const bytes = encoder.encode(part);
	const tokens: Token[] = [];
	for (let index = 0; index < bytes.length; index++) {
		const byte = bytes[index] ?? 0;
		const next = bytes[index + 1];
		if (byte === BACKSLASH && next !== undefined) {
			tokens.push({ kind: "byte", byte: next });
			index++;
		} else if (byte === STAR) {
			// `a**b` is `a*b`: only a whole part of two stars crosses directories.
			if (tokens.at(-1)?.kind !== "run") tokens.push({ kind: "run" });
		} else if (byte === QUESTION) {
			tokens.push({ kind: "one" });
		} else if (byte === OPEN) {
			const set = readSet(bytes, index);
			if (set) {
				tokens.push(set.token);
				index = set.end;
			} else {
				tokens.push({ kind: "byte", byte });
			}
		} else {
			tokens.push({ kind: "byte", byte });
		}
	}
	return tokens;
}

/**
 * The set that opens at `open`, and where it closes; null when it never does. It is made into a
 * table here, once, so that looking a byte up costs the same however long the set is written.
 */
function readSet(bytes: Uint8Array, open: number): { token: Token; end: number } | null {
	let index = open + 1;
	const negated = bytes[index] === BANG || bytes[index] === CARET;
	if (negated) index++;
	const takes = new Uint8Array(256);
	// A `]` right after the opening is one of the set.
	for (let first = true; index < bytes.length; first = false) {
		const byte = bytes[index] ?? 0;
		if (byte === CLOSE && !first) {
			if (negated) for (let each = 0; each < 256; each++) takes[each] = takes[each] === 1 ? 0 : 1;
			return { token: { kind: "set", takes }, end: index };
		}
		const to = bytes[index + 2];
		if (bytes[index + 1] === DASH && to !== undefined && to !== CLOSE) {
			for (let each = byte; each <= to; each++) takes[each] = 1;
			index += 3;
		} else {
			takes[byte] = 1;
			index++;
		}
	}
	return null;
}

interface Budget {
	left: number;
}

function spend(budget: Budget): void {
	if (--budget.left < 0) throw new GlobTooSlow();
}

/** The part as bytes: itself where it is ASCII, which most names are, and encoded where not. */
function bytesOf(part: string): { length: number; at(index: number): number } {
	for (let index = 0; index < part.length; index++) {
		if (part.charCodeAt(index) > 0x7f) {
			const bytes = encoder.encode(part);
			return { length: bytes.length, at: (at) => bytes[at] ?? 0 };
		}
	}
	return { length: part.length, at: (at) => part.charCodeAt(at) };
}

/** Whether a path's part matches a glob's: forward, and back to the last `*` when it fails. */
function matchPart(tokens: Token[], part: string, budget: Budget): boolean {
	const text = bytesOf(part);
	let token = 0;
	let byte = 0;
	let star = -1;
	let starByte = 0;
	while (byte < text.length) {
		spend(budget);
		const next = tokens[token];
		if (next && next.kind !== "run" && takes(next, text.at(byte))) {
			token++;
			byte++;
		} else if (next?.kind === "run") {
			star = token++;
			starByte = byte;
		} else if (star !== -1) {
			token = star + 1;
			byte = ++starByte;
		} else {
			return false;
		}
	}
	while (tokens[token]?.kind === "run") token++;
	return token === tokens.length;
}

function takes(token: Exclude<Token, { kind: "run" }>, byte: number): boolean {
	if (token.kind === "byte") return token.byte === byte;
	if (token.kind === "set") return token.takes[byte] === 1;
	return true;
}

function matchParts(
	glob: Part[],
	parts: readonly string[],
	start: number,
	budget: Budget,
): boolean {
	const width = parts.length + 1;
	// 0 for not tried, 1 for no, 2 for yes: each pair of a glob's part and a path's is worked out
	// once.
	const tried = new Uint8Array((glob.length + 1) * width);
	const lastAny = glob.lastIndexOf("**");
	const from = (at: number, part: number): boolean => {
		// Charged whether it is worked out or remembered: a `**` asks about every part after it,
		// and those askings are work too, however cheap each is.
		spend(budget);
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
