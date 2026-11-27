import type { ReviewFinding } from "@gateweave/agents-model";
import { headerPath } from "./changes";
import { type Git, isCommitId } from "./git-work";

interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
}
interface DiffFile {
	oldPath: string | null;
	newPath: string | null;
	hunks: Hunk[];
}
export type ParsedDiff = DiffFile[];

function pathOf(header: string, prefix: string): string | null {
	return header === "/dev/null" ? null : headerPath(header, prefix);
}

export function parseDiff(text: string): ParsedDiff {
	const files: ParsedDiff = [];
	let file: DiffFile | undefined;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of text.split("\n")) {
		if (oldLeft > 0 || newLeft > 0) {
			// A removed or added line can look exactly like a path header.
			if (line.startsWith("\\ No newline")) continue;
			if (line.startsWith("-") || line.startsWith(" ")) oldLeft--;
			if (line.startsWith("+") || line.startsWith(" ")) newLeft--;
			continue;
		}
		if (line.startsWith("diff --git ")) {
			file = { oldPath: null, newPath: null, hunks: [] };
			files.push(file);
		} else if (file) {
			if (line.startsWith("rename from ")) file.oldPath = headerPath(line.slice(12), "");
			else if (line.startsWith("rename to ")) file.newPath = headerPath(line.slice(10), "");
			else if (line.startsWith("--- ")) file.oldPath = pathOf(line.slice(4), "a/");
			else if (line.startsWith("+++ ")) file.newPath = pathOf(line.slice(4), "b/");
			else if (line.startsWith("Binary files ")) {
				// Renames already have both paths. Otherwise the names around " and "
				// have equal length, unless one side is /dev/null.
				const names = line.slice("Binary files ".length, -" differ".length);
				const split = names.startsWith("/dev/null and ")
					? 9
					: names.endsWith(" and /dev/null")
						? names.length - 14
						: (names.length - 5) / 2;
				file.oldPath ??= pathOf(names.slice(0, split), "a/");
				file.newPath ??= pathOf(names.slice(split + 5), "b/");
			} else {
				const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
				if (!hunk) continue;
				oldLeft = Number(hunk[2] ?? 1);
				newLeft = Number(hunk[4] ?? 1);
				file.hunks.push({
					oldStart: Number(hunk[1]),
					oldLines: oldLeft,
					newStart: Number(hunk[3]),
					newLines: newLeft,
				});
			}
		}
	}
	return files;
}

export function lineOnDiff(
	diff: ParsedDiff,
	{ path, line, side }: Pick<ReviewFinding, "path" | "line" | "side">,
): boolean {
	return diff.some((file) => {
		if ((side === "LEFT" ? file.oldPath : file.newPath) !== path) return false;
		return file.hunks.some((hunk) => {
			const [start, count] =
				side === "LEFT"
					? ([hunk.oldStart, hunk.oldLines] as const)
					: ([hunk.newStart, hunk.newLines] as const);
			return start <= line && line < start + count;
		});
	});
}

export async function readReviewDiff(
	git: Git,
	base: string,
	head: string,
	diffLimit = 5_000_000,
): Promise<{ diff: string; mergeBase: string } | { error: string }> {
	if (!isCommitId(head)) return { error: "The reviewed head is not a commit id" };
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base))
		return { error: "The review base is not a plain ref" };
	try {
		const common = await git(["merge-base", base, head]);
		const mergeBase = common.output.trim();
		if (common.timedOut || common.exitCode !== 0 || common.omitted || !isCommitId(mergeBase))
			return { error: "The common base of the review could not be found" };
		const result = await git(
			[
				"-c",
				"core.quotePath=false",
				"diff",
				"--no-color",
				"--no-ext-diff",
				"--find-renames",
				// The parser strips a/ and b/: a configured diff.noprefix or mnemonic prefix must not change them.
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--unified=3",
				mergeBase,
				head,
				"--",
			],
			undefined,
			undefined,
			diffLimit,
		);
		if (result.omitted) return { error: "The review diff is too large to read in full" };
		if (result.exitCode === 0 && !result.timedOut) return { diff: result.output, mergeBase };
	} catch {
		// A sandbox that lost the checkout may throw before git starts.
	}
	return { error: "The review diff could not be read" };
}

export async function restoreHead(git: Git, head: string): Promise<string | null> {
	try {
		if (isCommitId(head)) {
			const reset = await git(["reset", "--hard", "--quiet", head]);
			if (reset.exitCode === 0 && !reset.timedOut) {
				const clean = await git(["clean", "-fdq"]);
				if (clean.exitCode === 0 && !clean.timedOut) return null;
			}
		}
	} catch {
		// A lost sandbox leaves the checkout unverified too.
	}
	return "the checkout could not be put back at the reviewed head";
}

/** What `createProofFile` needs of a file system: native calls, nothing that follows a symlink. */
export interface ProofFiles {
	/** The kind of thing at the path without following a symlink, or null when nothing is there. */
	lstat(path: string): Promise<{ type: string } | null>;
	/** Makes the directory and its missing parents. */
	mkdir(path: string): Promise<void>;
	writeFile(path: string, content: string): Promise<void>;
}

/**
 * Creates the file of a proposed test, which must be new: a path that exists already, whatever it
 * is, or that goes through a symlink or anything but a directory, is refused, so a proposed test
 * can never replace a tracked file or write outside the checkout. `relative` is a plain path
 * inside `root`.
 */
export async function createProofFile(
	files: ProofFiles,
	root: string,
	relative: string,
	content: string,
): Promise<{ written: number } | { error: string }> {
	try {
		const parts = relative.split("/");
		let seen = root;
		for (const [index, part] of parts.entries()) {
			seen = `${seen}/${part}`;
			const found = await files.lstat(seen);
			// Nothing here, so nothing below it either.
			if (!found) break;
			const shown = parts.slice(0, index + 1).join("/");
			if (index === parts.length - 1) return { error: `${shown} already exists` };
			if (found.type !== "directory")
				return {
					error: `${shown} is ${found.type === "symlink" ? "a symlink" : "not a directory"}`,
				};
		}
		const target = `${root}/${relative}`;
		const directory = target.slice(0, target.lastIndexOf("/"));
		if (directory !== root) await files.mkdir(directory);
		await files.writeFile(target, content);
		return { written: new TextEncoder().encode(content).length };
	} catch {
		return { error: "the file could not be created" };
	}
}
