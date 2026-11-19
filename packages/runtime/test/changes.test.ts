import { expect, it } from "vitest";
import { changesBase, turnChanges } from "../src/changes";
import type { Git } from "../src/git-work";
import type { CommandResult } from "../src/sandbox-tools";

const TREE = "a".repeat(40);

function fakeGit(answers: Record<string, CommandResult | Error>): { git: Git; calls: string[][] } {
	const calls: string[][] = [];
	const git: Git = async (args) => {
		calls.push(args);
		const key = args.slice(0, 2).join(" ");
		const answer = answers[key];
		if (answer instanceof Error) throw answer;
		if (!answer) return { exitCode: 0, output: "", timedOut: false };
		return answer;
	};
	return { git, calls };
}

it("writes the checkout's state as a tree, adding every change first", async () => {
	const { git, calls } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"write-tree": { exitCode: 0, output: `${TREE}\n`, timedOut: false },
	});
	expect(await changesBase(git)).toBe(TREE);
	expect(calls).toEqual([["add", "--all"], ["write-tree"]]);
});

it("answers no base when there is no checkout or git fails", async () => {
	const { git } = fakeGit({
		"add --all": { exitCode: 128, output: "not a git repository", timedOut: false },
	});
	expect(await changesBase(git)).toBeNull();
	const broken: Git = async () => {
		throw new Error("no container");
	};
	expect(await changesBase(broken)).toBeNull();
});

const PATCH = [
	"diff --git a/src/app.ts b/src/app.ts",
	"index 1111111..2222222 100644",
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -1,3 +1,4 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	"+const c = 4;",
	"",
	"diff --git a/docs/new.md b/docs/new.md",
	"new file mode 100644",
	"index 0000000..3333333",
	"--- /dev/null",
	"+++ b/docs/new.md",
	"@@ -0,0 +1,2 @@",
	"+hello",
	"+world",
	"",
	"diff --git a/old.txt b/old.txt",
	"deleted file mode 100644",
	"index 4444444..0000000",
	"--- a/old.txt",
	"+++ /dev/null",
	"@@ -1,2 +0,0 @@",
	"-gone",
	"-away",
	"",
].join("\n");

it("sums up each changed file with its line counts and diff", async () => {
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: PATCH, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	expect(changes).toEqual({
		truncated: false,
		files: [
			{ path: "src/app.ts", added: 2, deleted: 1, diff: expect.stringContaining("+const c = 4;") },
			{ path: "docs/new.md", added: 2, deleted: 0, diff: expect.stringContaining("+hello") },
			{ path: "old.txt", added: 0, deleted: 2, diff: expect.stringContaining("-gone") },
		],
	});
});

it("answers null when nothing changed or git cannot say", async () => {
	const empty = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: "", timedOut: false },
	});
	expect(await turnChanges(empty.git, TREE)).toBeNull();
	const failed = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 128, output: "bad base", timedOut: false },
	});
	expect(await turnChanges(failed.git, TREE)).toBeNull();
});

it("takes what looks like a secret out of the diff, keeping the marks and counts", async () => {
	const patch = [
		"diff --git a/.env b/.env",
		"--- a/.env",
		"+++ b/.env",
		"@@ -1,3 +1,4 @@",
		" API_URL=https://example.com",
		"+API_KEY=sk-abcdefghijklmnopqrstuvwx",
		"+TOKEN: ghp_abcdefghijklmnopqrstuvwx",
		"+-----BEGIN RSA PRIVATE KEY-----",
		"+MIIEowIBAAKCAQEA7",
		"+-----END RSA PRIVATE KEY-----",
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	expect(changes?.files).toHaveLength(1);
	const file = changes?.files[0];
	expect(file?.added).toBe(5);
	expect(file?.deleted).toBe(0);
	expect(file?.diff).not.toContain("sk-abcdef");
	expect(file?.diff).not.toContain("ghp_abcdef");
	expect(file?.diff).not.toContain("MIIEowIBAA");
	expect(file?.diff).toContain(" [redacted]");
	expect(file?.diff).toContain("API_URL=https://example.com");
});

it("holds the diff to its bounds and says when it cut", async () => {
	const many = Array.from({ length: 105 }, (_, index) => {
		return [
			`diff --git a/f${index}.ts b/f${index}.ts`,
			`--- a/f${index}.ts`,
			`+++ b/f${index}.ts`,
			"@@ -0,0 +1 @@",
			"+x",
			"",
		].join("\n");
	}).join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: many, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	expect(changes?.files).toHaveLength(100);
	expect(changes?.truncated).toBe(true);
});

it("cuts one file's diff at its bound", async () => {
	const long = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,${30_000} @@\n${"+line\n".repeat(30_000)}`;
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: long, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	const file = changes?.files[0];
	expect(file?.path).toBe("big.ts");
	expect(file?.added).toBe(30_000);
	expect((file?.diff.length ?? 0) <= 20_000).toBe(true);
	expect(changes?.truncated).toBe(true);
});

it("counts content lines that begin with diff marks, inside the hunks only", async () => {
	const patch = [
		"diff --git a/mixed.txt b/mixed.txt",
		"--- a/mixed.txt",
		"+++ b/mixed.txt",
		"@@ -1,1 +1,1 @@",
		"----",
		"+++counter;",
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	// `----` removes a line of `---`, `+++counter;` adds `++counter;`: the headers' own
	// `---`/`+++` lines are not changes.
	expect(changes?.files[0]?.added).toBe(1);
	expect(changes?.files[0]?.deleted).toBe(1);
});

it("reads a path Git quoted, octal escapes and all", async () => {
	const patch = [
		'diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"',
		'--- "a/\\303\\251.ts"',
		'+++ "b/\\303\\251.ts"',
		"@@ -0,0 +1 @@",
		"+x",
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	expect(changes?.files[0]?.path).toBe("é.ts");
});

it("takes a credential out when its key is quoted, as JSON writes it", async () => {
	const patch = [
		"diff --git a/config.json b/config.json",
		"--- a/config.json",
		"+++ b/config.json",
		"@@ -1,1 +1,2 @@",
		'+"password": "hunter2",',
		'+"api_key": "abcdef123456",',
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	const diff = changes?.files[0]?.diff ?? "";
	expect(diff).not.toContain("hunter2");
	expect(diff).not.toContain("abcdef123456");
	expect(diff.match(/ \[redacted\]/g)).toHaveLength(2);
});

it("keeps redacting a private key's body past a line that holds END", async () => {
	const patch = [
		"diff --git a/key.pem b/key.pem",
		"--- a/key.pem",
		"+++ b/key.pem",
		"@@ -0,0 +1,4 @@",
		"+-----BEGIN RSA PRIVATE KEY-----",
		"+MIIEENDofffbody",
		"+morebody",
		"+-----END RSA PRIVATE KEY-----",
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	const diff = changes?.files[0]?.diff ?? "";
	expect(diff).not.toContain("MIIEENDofffbody");
	expect(diff).not.toContain("morebody");
	expect(diff.match(/ \[redacted\]/g)).toHaveLength(4);
});

it("drops a patch's partial last section when the patch itself was clipped", async () => {
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: PATCH, timedOut: false, omitted: 500 },
	});
	const changes = await turnChanges(git, TREE);
	// PATCH's last section (old.txt) is the one the cut fell in: what remains is whole.
	expect(changes?.files.map((file) => file.path)).toEqual(["src/app.ts", "docs/new.md"]);
	expect(changes?.truncated).toBe(true);
});

it("keeps a path with a space, TAB and all, from Git's headers", async () => {
	const patch = [
		"diff --git a/my file.txt b/my file.txt",
		"--- a/my file.txt\t",
		"+++ b/my file.txt\t",
		"@@ -1,1 +1,1 @@",
		"-old",
		"+new",
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	expect(changes?.files.map((file) => file.path)).toEqual(["my file.txt"]);
});

it("names a binary file whose path has a space from its diff --git line", async () => {
	const patch = [
		"diff --git a/my file.bin b/my file.bin",
		"index 1111111..2222222 100644",
		"Binary files a/my file.bin and b/my file.bin differ",
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	expect(changes?.files.map((file) => file.path)).toEqual(["my file.bin"]);
});

it("takes out credentials whose keys merely contain a secret's word, and URL logins", async () => {
	const patch = [
		"diff --git a/.env b/.env",
		"--- a/.env",
		"+++ b/.env",
		"@@ -0,0 +1,3 @@",
		"+SECRET_KEY=abc123",
		"+AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		"+DATABASE_URL=postgres://user:secretpass@db.example.com/app",
		"",
	].join("\n");
	const { git } = fakeGit({
		"add --all": { exitCode: 0, output: "", timedOut: false },
		"diff --cached": { exitCode: 0, output: patch, timedOut: false },
	});
	const changes = await turnChanges(git, TREE);
	const diff = changes?.files[0]?.diff ?? "";
	for (const secret of ["abc123", "wJalrXUtn", "secretpass"]) {
		expect(diff).not.toContain(secret);
	}
	expect(diff.match(/ \[redacted\]/g)).toHaveLength(3);
});
