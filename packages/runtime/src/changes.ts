/**
 * What a turn changed in its sandbox's checkout, as a `CHANGES_PART`. The base is a tree
 * of the checkout's state before the turn's work: `changesBase` writes it, `turnChanges` diffs the
 * checkout against it once the turn is done. Both run git through `./git-work.ts`'s `Git`, so a
 * sandbox that is not a git checkout, or one whose diff cannot be read, answers null and the reply
 * carries no part — a change that cannot be summed is never invented.
 */
import type { ChangesFile, ChangesPartData } from "@gateweave/agents-model";
import type { Git } from "./git-work";

/**
 * What a conversation reaches of its sandbox to sum up a turn's changes. A sandbox
 * without a repository checked out answers null to both.
 */
export interface ChangesPort {
	/** The checkout's state as a tree, before the turn's work; null when there is no checkout. */
	changesBase(): Promise<string | null>;
	/** What changed since `base` names, or null when nothing did or git cannot say. */
	turnChanges(base: string): Promise<ChangesPartData | null>;
}

/** Most files a `CHANGES_PART` carries; the rest are counted in `truncated`. */
const MAX_FILES = 100;
/** The longest one file's diff may be; a longer diff is cut. */
const MAX_FILE_DIFF = 20_000;
/** The longest every diff together may be; past it, files are left out. */
const MAX_TOTAL_DIFF = 200_000;
/** Bytes of patch `turnChanges` reads at most, before the part's own bounds cut it. */
const DIFF_OUTPUT_BYTES = 1_000_000;

/** A tree id as `git write-tree` prints it. */
const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The checkout's state as a tree, or null when there is no checkout or git cannot say. */
export async function changesBase(git: Git): Promise<string | null> {
	try {
		const added = await git(["add", "--all"]);
		if (added.exitCode !== 0) return null;
		const tree = await git(["write-tree"]);
		const id = tree.output.trim();
		return tree.exitCode === 0 && TREE_ID.test(id) ? id : null;
	} catch {
		return null;
	}
}

/**
 * What differs between the checkout and the state `base` names, or null when nothing differs or
 * git cannot say. Every change is staged first, so a file the turn created counts and one it
 * deleted shows; a commit the turn made shows too, since the diff is against the tree and not a
 * commit.
 */
export async function turnChanges(git: Git, base: string): Promise<ChangesPartData | null> {
	try {
		const added = await git(["add", "--all"]);
		if (added.exitCode !== 0) return null;
		// A patch can be long, so it is read whole up to a bound of its own, as a prefix: the
		// head-and-tail clip a command's output gets would tear its sections apart.
		const diff = await git(
			["diff", "--cached", "--no-renames", "--unified=3", "--patch", base],
			120,
			undefined,
			DIFF_OUTPUT_BYTES,
		);
		if (diff.exitCode !== 0) return null;
		return summarize(diff.output, diff.omitted !== undefined && diff.omitted > 0);
	} catch {
		return null;
	}
}

/**
 * The patch split into its files, counted and redacted, within the bounds. `clipped` says the
 * patch itself was cut at its bound: its last section is then partial and dropped, and what
 * follows it is gone, which `truncated` says.
 */
function summarize(patch: string, clipped = false): ChangesPartData | null {
	const sections = patch
		.split(/^(?=diff --git )/m)
		.filter((each) => each.startsWith("diff --git "));
	if (sections.length === 0) return null;
	if (clipped) sections.pop();
	if (sections.length === 0) return null;
	const files: ChangesFile[] = [];
	let total = 0;
	let truncated = clipped;
	for (const section of sections) {
		if (files.length >= MAX_FILES || total >= MAX_TOTAL_DIFF) {
			truncated = true;
			break;
		}
		const path = pathOf(section);
		if (path === null) continue;
		const redacted = redact(section);
		const { added, deleted } = lineCounts(redacted);
		const text = redacted.length > MAX_FILE_DIFF ? redacted.slice(0, MAX_FILE_DIFF) : redacted;
		if (text.length < redacted.length || total + text.length > MAX_TOTAL_DIFF) truncated = true;
		files.push({ path, added, deleted, diff: text.slice(0, MAX_TOTAL_DIFF - total) });
		total += files[files.length - 1]?.diff.length ?? 0;
	}
	if (files.length === 0) return null;
	if (sections.length > files.length) truncated = true;
	return { files, truncated };
}

/**
 * A section's added and removed lines, counted inside its hunks: before the first `@@` are the
 * file's headers, whose `+++` and `---` lines are not changes, and a content line that itself
 * begins with marks (`+++counter;` adds `++counter;`) counts like any other.
 */
function lineCounts(section: string): { added: number; deleted: number } {
	let added = 0;
	let deleted = 0;
	let inHunk = false;
	for (const line of section.split("\n")) {
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) deleted++;
	}
	return { added, deleted };
}

/** The path a patch section's file has, from its `+++`/`---` header or its `diff --git` line. */
function pathOf(section: string): string | null {
	const lines = section.split("\n");
	for (const line of lines) {
		if (line.startsWith("+++ ")) {
			const path = headerPath(line.slice(4), "b/");
			// A deleted file's `+++` is `/dev/null`; its `---` names it below.
			if (path !== "/dev/null") return path;
		}
	}
	for (const line of lines) {
		if (line.startsWith("--- ")) {
			const path = headerPath(line.slice(4), "a/");
			// A new file's `---` is `/dev/null`; nothing below names it.
			if (path !== "/dev/null") return path;
		}
	}
	// A binary file's section has no `---`/`+++` lines; its `diff --git` line names it.
	const head = lines[0] ?? "";
	const match = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(head);
	if (match !== null) {
		const target = unquote(match[2] ?? "");
		return target.startsWith("b/") ? target.slice(2) : target;
	}
	// A path with a space is written unquoted, the same on both sides: `a/my file.txt b/my file.txt`.
	const plain = /^diff --git a\/(.+) b\/\1$/.exec(head);
	return plain === null ? null : (plain[1] ?? null);
}

/**
 * The path a `---`/`+++` header names: Git's quoting undone first, since a quoted path carries
 * its `a/` or `b/` prefix inside the quotes, and only then the prefix dropped.
 */
export function headerPath(text: string, prefix: string): string {
	// Git ends a header's path with a TAB when the path holds a space; a quoted path never does.
	const path = unquote(text.replace(/\t$/, ""));
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Git's quoting of a path it finds unusual, undone: `\NNN` octal bytes as UTF-8. */
function unquote(path: string): string {
	if (!(path.length > 1 && path.startsWith('"') && path.endsWith('"'))) return path;
	const bytes: number[] = [];
	const inner = path.slice(1, -1);
	for (let at = 0; at < inner.length; at++) {
		const char = inner.charAt(at);
		if (char !== "\\" || at + 1 >= inner.length) {
			for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
			continue;
		}
		const next = inner.charAt(at + 1);
		const octal = inner.slice(at + 1, at + 4);
		if (/^[0-7]{3}$/.test(octal)) {
			bytes.push(Number.parseInt(octal, 8));
			at += 3;
		} else {
			for (const byte of new TextEncoder().encode(next)) bytes.push(byte);
			at += 1;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** What a secret looks like on one line of a diff, and a private key's block around it. */
const SECRET_LINE =
	/(BEGIN [A-Z ]*PRIVATE KEY|["']?authorization["']?\s*:|bearer\s+\S|["']?[\w-]*(?:secret|token|password|passwd|api[-_ ]?key|private[-_ ]?key|access[-_ ]?key)[\w-]*["']?\s*[:=]|[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]+@|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/i;

const REDACTED = " [redacted]";

/**
 * The patch with what looks like a secret taken out: a matching line keeps its `+`/`-` and loses
 * its content, and every line of a private key's block is blanked. The line counts do not change,
 * since the marks stay.
 */
function redact(patch: string): string {
	let inKey = false;
	return patch
		.split("\n")
		.map((line) => {
			const mark =
				line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line.charAt(0) : "";
			if (mark === "") return line;
			// The block's own markers, matched whole: a body line can hold the letters "END".
			if (/BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
				inKey = true;
				return `${mark}${REDACTED}`;
			}
			if (/END [A-Z ]*PRIVATE KEY-----/.test(line)) {
				inKey = false;
				return `${mark}${REDACTED}`;
			}
			if (inKey) return `${mark}${REDACTED}`;
			if (SECRET_LINE.test(line)) return `${mark}${REDACTED}`;
			return line;
		})
		.join("\n");
}
