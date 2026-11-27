import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { changedSince, type Git } from "../src/git-work";
import {
	createProofFile,
	lineOnDiff,
	type ParsedDiff,
	type ProofFiles,
	parseDiff,
	readReviewDiff,
	restoreHead,
} from "../src/review-git";

const directory = mkdtempSync(join(tmpdir(), "review-git-"));
const write = (path: string, text: string) => writeFileSync(join(directory, path), text);
function command(...args: string[]) {
	const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
		cwd: directory,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: join(directory, "no-global-config"),
			GIT_CONFIG_NOSYSTEM: "1",
			XDG_CONFIG_HOME: directory,
		},
	});
	if (result.status !== 0) throw new Error(result.stderr.toString());
	return result.stdout;
}
const git: Git = async (args, _seconds, _env, limit) => {
	const bytes = command(...args);
	return {
		exitCode: 0,
		output: bytes.subarray(0, limit).toString(),
		timedOut: false,
		omitted: Math.max(0, bytes.length - (limit ?? bytes.length)),
	};
};
let head: string;
let diff: ParsedDiff;
const on = (path: string, line: number, side: "RIGHT" | "LEFT" = "RIGHT") =>
	lineOnDiff(diff, { path, line, side });
beforeAll(async () => {
	command("init", "--initial-branch=main");
	command("config", "user.name", "Reviewer");
	command("config", "user.email", "review@example.com");
	const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join("");
	write("old", lines);
	write("untouched", "unique\n");
	write("deleted", "gone\n");
	write("a space", lines.replace("line 4", "-- old"));
	write("shortened", lines);
	write("é😀", "before\n");
	write("binary", "\0a");
	write("removed binary", "\0removed");
	command("add", ".");
	command("commit", "-qm", "Base");
	command("switch", "-qc", "review");
	command("mv", "old", "new");
	write("new", lines.replace("line 4", "edit"));
	command("mv", "untouched", "renamed");
	command("rm", "deleted");
	write("added", "hello\n");
	write("a space", lines.replace("line 4", "++ new"));
	write("shortened", lines.slice(0, lines.indexOf("line 10")));
	write("é😀", "after\n");
	write("binary", "\0b");
	command("rm", "removed binary");
	write("added binary", "\0added");
	command("add", ".");
	command("commit", "-qm", "Changes");
	head = command("rev-parse", "HEAD").toString().trim();
	const read = await readReviewDiff(git, "main", head);
	if ("error" in read) throw new Error(read.error);
	expect(read.mergeBase).toBe(command("rev-parse", "main").toString().trim());
	diff = parseDiff(read.diff);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("includes the last context line and excludes the next line", () => {
	expect(on("a space", 7)).toBe(true);
	expect(on("a space", 8)).toBe(false);
});
it("uses the old line range for deleted lines", () => {
	expect(on("shortened", 18, "LEFT")).toBe(true);
	expect(on("shortened", 18)).toBe(false);
});
it("matches the old name on LEFT and the new name on RIGHT after a rename", () => {
	expect(on("new", 4)).toBe(true);
	expect(on("old", 4, "LEFT")).toBe(true);
	expect(on("old", 4)).toBe(false);
});
it("keeps both names of a pure rename without inventing a hunk", () => {
	expect(diff).toContainEqual({ oldPath: "untouched", newPath: "renamed", hunks: [] });
	expect(on("renamed", 1)).toBe(false);
});
it("reads paths with spaces and treats header-like hunk lines as content", () => {
	expect(on("a space", 4)).toBe(true);
	expect(on("a space", 4, "LEFT")).toBe(true);
});
it("uses only the side that exists for added and deleted files", () => {
	expect(on("added", 1)).toBe(true);
	expect(on("added", 1, "LEFT")).toBe(false);
	expect(on("deleted", 1, "LEFT")).toBe(true);
	expect(on("deleted", 1)).toBe(false);
});
it("reads quoted paths with UTF-8 octal bytes and escaped quotes", () => {
	expect(on("é😀", 1)).toBe(true);
	// Without `core.quotePath=false` git quotes the path's bytes in octal.
	const quoted = parseDiff(command("diff", "main", "HEAD").toString());
	expect(lineOnDiff(quoted, { path: "é😀", line: 1, side: "RIGHT" })).toBe(true);
	// A path git cannot show bare, as a file of this name cannot exist on every system.
	const text =
		'diff --git "a/x\\"y\\\\" "b/x\\"y\\\\"\n--- "a/x\\"y\\\\"\n+++ "b/x\\"y\\\\"\n@@ -1 +1 @@\n-a\n+b\n';
	expect(lineOnDiff(parseDiff(text), { path: 'x"y\\', line: 1, side: "RIGHT" })).toBe(true);
});
it("keeps binary files without hunks", () => {
	expect(diff).toContainEqual({ oldPath: "binary", newPath: "binary", hunks: [] });
	expect(diff).toContainEqual({ oldPath: null, newPath: "added binary", hunks: [] });
	expect(diff).toContainEqual({ oldPath: "removed binary", newPath: null, hunks: [] });
});
it("refuses an invalid head or option-shaped base before running git", async () => {
	const calls: string[][] = [];
	const seen: Git = (...args) => {
		calls.push(args[0]);
		return git(...args);
	};
	expect(await readReviewDiff(seen, "main", "HEAD")).toHaveProperty("error");
	expect(await readReviewDiff(seen, "--all", head)).toHaveProperty("error");
	expect(calls).toEqual([]);
});
it("refuses a partial diff", async () => {
	expect(await readReviewDiff(git, "main", head, 50)).toEqual({
		error: expect.stringContaining("too large"),
	});
});
it("restores modified, deleted and untracked files to the reviewed head", async () => {
	write("added", "other");
	rmSync(join(directory, "shortened"));
	write("untracked", "new file");
	expect(await changedSince(git, head)).not.toBeNull();
	expect(await restoreHead(git, head)).toBeNull();
	expect(await changedSince(git, head)).toBeNull();
});
it("reads the same diff whatever prefixes git is configured to show", async () => {
	const configured: Git = (args, ...rest) =>
		git(["-c", "diff.noprefix=true", "-c", "diff.mnemonicPrefix=true", ...args], ...rest);
	const read = await readReviewDiff(configured, "main", head);
	if ("error" in read) throw new Error(read.error);
	expect(parseDiff(read.diff)).toEqual(diff);
});

/** A file system in memory, where a path is a directory, a file or a symlink. */
function memoryFiles(entries: Record<string, string>) {
	const kinds = new Map(Object.entries(entries));
	const written = new Map<string, string>();
	const files: ProofFiles = {
		lstat: async (path) => {
			const type = kinds.get(path);
			return type ? { type } : null;
		},
		mkdir: async (path) => {
			let at = "";
			for (const part of path.split("/").slice(1)) {
				at += `/${part}`;
				if (!kinds.has(at)) kinds.set(at, "directory");
			}
		},
		writeFile: async (path, content) => {
			written.set(path, content);
			kinds.set(path, "file");
		},
	};
	return { files, written };
}
const ROOT = "/workspace/repo";

it("creates a new file and the directories it needs", async () => {
	const { files, written } = memoryFiles({ [ROOT]: "directory" });
	expect(await createProofFile(files, ROOT, "test/deep/a.test.ts", "body")).toEqual({
		written: 4,
	});
	expect(written.get(`${ROOT}/test/deep/a.test.ts`)).toBe("body");
});
it("refuses a path that exists, whatever it is, and writes nothing", async () => {
	for (const type of ["file", "symlink", "directory"]) {
		const { files, written } = memoryFiles({
			[ROOT]: "directory",
			[`${ROOT}/test`]: "directory",
			[`${ROOT}/test/a.test.ts`]: type,
		});
		expect(await createProofFile(files, ROOT, "test/a.test.ts", "body")).toEqual({
			error: "test/a.test.ts already exists",
		});
		expect(written.size).toBe(0);
	}
});
it("refuses to go through a symlink or a file on the way", async () => {
	const symlink = memoryFiles({ [ROOT]: "directory", [`${ROOT}/test`]: "symlink" });
	expect(await createProofFile(symlink.files, ROOT, "test/a.test.ts", "body")).toEqual({
		error: "test is a symlink",
	});
	const file = memoryFiles({ [ROOT]: "directory", [`${ROOT}/test`]: "file" });
	expect(await createProofFile(file.files, ROOT, "test/a.test.ts", "body")).toEqual({
		error: "test is not a directory",
	});
	expect(symlink.written.size + file.written.size).toBe(0);
});
it("answers a failing file system with an error and no throw", async () => {
	const { files } = memoryFiles({ [ROOT]: "directory" });
	files.writeFile = async () => {
		throw new Error("disk full");
	};
	expect(await createProofFile(files, ROOT, "a.test.ts", "body")).toEqual({
		error: "the file could not be created",
	});
});
