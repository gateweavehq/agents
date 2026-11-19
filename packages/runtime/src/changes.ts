/**
 * What a turn changed in its sandbox's checkout, as a `CHANGES_PART` (AGT-139). The base is a tree
 * of the checkout's state before the turn's work: `changesBase` writes it, `turnChanges` diffs the
 * checkout against it once the turn is done. Both run git through `./git-work.ts`'s `Git`, so a
 * sandbox that is not a git checkout, or one whose diff cannot be read, answers null and the reply
 * carries no part — a change that cannot be summed is never invented.
 */
import type { ChangesFile, ChangesPartData } from "@gateweave/agents-model";
import type { Git } from "./git-work";

/**
 * What a conversation reaches of its sandbox to sum up a turn's changes (AGT-139). A sandbox
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
		const diff = await git(
			["diff", "--cached", "--no-renames", "--unified=3", "--patch", base],
			120,
		);
		if (diff.exitCode !== 0) return null;
		return summarize(diff.output);
	} catch {
		return null;
	}
}

/** The patch split into its files, counted and redacted, within the bounds. */
function summarize(patch: string): ChangesPartData | null {
	const sections = patch
		.split(/^(?=diff --git )/m)
		.filter((each) => each.startsWith("diff --git "));
	if (sections.length === 0) return null;
	const files: ChangesFile[] = [];
	let total = 0;
	let truncated = false;
	for (const section of sections) {
		if (files.length >= MAX_FILES || total >= MAX_TOTAL_DIFF) {
			truncated = true;
			break;
		}
		const path = pathOf(section);
		if (path === null) continue;
		const redacted = redact(section);
		const added = redacted
			.split("\n")
			.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
		const deleted = redacted
			.split("\n")
			.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
		const text = redacted.length > MAX_FILE_DIFF ? redacted.slice(0, MAX_FILE_DIFF) : redacted;
		if (text.length < redacted.length || total + text.length > MAX_TOTAL_DIFF) truncated = true;
		files.push({ path, added, deleted, diff: text.slice(0, MAX_TOTAL_DIFF - total) });
		total += files[files.length - 1]?.diff.length ?? 0;
	}
	if (files.length === 0) return null;
	if (sections.length > files.length) truncated = true;
	return { files, truncated };
}

/** The path a patch section's file has, from its `+++`/`---` header or its `diff --git` line. */
function pathOf(section: string): string | null {
	const lines = section.split("\n");
	for (const line of lines) {
		if (line.startsWith("+++ ")) {
			const path = unquote(line.slice(4).replace(/^b\//, ""));
			// A deleted file's `+++` is `/dev/null`; its `---` names it below.
			if (path !== "/dev/null") return path;
		}
	}
	for (const line of lines) {
		if (line.startsWith("--- ")) {
			const path = unquote(line.slice(4).replace(/^a\//, ""));
			// A new file's `---` is `/dev/null`; nothing below names it.
			if (path !== "/dev/null") return path;
		}
	}
	// A binary file's section has no `---`/`+++` lines; its `diff --git` line names it.
	const head = lines[0] ?? "";
	const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(head);
	return match?.[2] ? unquote(match[2]) : null;
}

/** Git's quoting of a path it finds unusual, undone. */
function unquote(path: string): string {
	if (path.length > 1 && path.startsWith('"') && path.endsWith('"')) {
		return path.slice(1, -1).replace(/\\(.)/g, "$1");
	}
	return path;
}

/** What a secret looks like on one line of a diff, and a private key's block around it. */
const SECRET_LINE =
	/(BEGIN [A-Z ]*PRIVATE KEY|authorization\s*:|bearer\s+\S|api[-_ ]?key\s*[:=]|secret\s*[:=]|token\s*[:=]|password\s*[:=]|passwd\s*[:=]|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/i;

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
			if (line.includes("PRIVATE KEY-----")) {
				inKey = !line.includes("END");
				return `${mark}${REDACTED}`;
			}
			if (inKey) {
				if (line.includes("END")) inKey = false;
				return `${mark}${REDACTED}`;
			}
			if (SECRET_LINE.test(line)) return `${mark}${REDACTED}`;
			return line;
		})
		.join("\n");
}
