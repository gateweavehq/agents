import { FakeGit } from "@gateweave/agents-github/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DeletingFilePort,
	deletingFileTools,
	SANDBOX_FILE_WORDS,
	sandboxFiles,
} from "../src/sandbox-tools";
import { MemorySandbox } from "./fake-sandbox";
import {
	BRANCH,
	calling,
	inConversation,
	RipgrepSandbox,
	recorder,
	repositoryOf,
	storeOver,
	useGitHub,
} from "./file-store-support";

// The tools for files, asked the same things of both kinds of port: a sandbox's files and the
// files store, which keeps a repository's files with no machine. Every answer below is the same
// text from both, so a model reads one as it reads the other.
//
// What this shows: that the tools, the sentences and the formats are the same over both ports,
// through a turn's worth of calls that read, write, edit, delete and then list and search what
// they left.
//
// What it does not show by itself: that the sandbox's side is ripgrep. There is no container
// here, so that side is `RipgrepSandbox`, a stand-in that answers the port's two command lines
// from files in memory. It is held to the sandbox image's real ripgrep elsewhere:
// `ripgrep-recorded.test.ts` runs it, and the store, over output recorded from that ripgrep.
// This suite's files change as it goes, which no recording follows, so what is compared here is
// the store with the stand-in, and what makes that worth something is the other suite. Its `rm`
// is not recorded at all: the two ports refuse a missing file each in its own words, and the
// suite asks only that both refuse and name it.
//
// Where the two differ on purpose (`../src/file-store.ts` lists where), the store's own suites
// hold it to its rule.

afterEach(() => {
	vi.unstubAllGlobals();
});

const LONG = `${"x".repeat(600)} needle`;

/** A repository's files, by path from its root. */
const FILES: Record<string, string> = {
	"README.md": "# Site\n\nA needle in the readme.\n",
	"docs/guide.md": "# Guide\n\nFirst line.\nSecond needle line.\n",
	"docs/api/reference.md": "# Reference\n",
	"src/index.ts": 'export const name = "site";\n',
	"src/util/text.ts": "export function trim(text: string) {\n\treturn text.trim();\n}\n",
	"src/util.ts": "export * from './util/text';\n",
	"src/Big.ts": "// NEEDLE in capitals\n",
	".github/CODEOWNERS": "* @acme/needle-team\n",
	"windows.txt": "one\r\ntwo needle\r\n",
	"long.txt": `${LONG}\nshort needle\n`,
	"marked.txt": "\uFEFFneedle after a mark\n",
};

type Port = (body: (files: DeletingFilePort) => Promise<void>) => Promise<void>;

const ports: [string, Port][] = [
	[
		"a sandbox's files",
		async (body) => {
			const sandbox = new RipgrepSandbox();
			for (const [path, content] of Object.entries(FILES)) {
				sandbox.files.set(`/workspace/repo/${path}`, content);
			}
			await body(sandboxFiles(sandbox));
		},
	],
	[
		"the files store",
		async (body) => {
			const fake = new FakeGit();
			await fake.seed(FILES);
			useGitHub(fake);
			await inConversation(async (storage) => {
				const { store } = storeOver(storage, fake);
				expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: true });
				await body(store);
			});
		},
	],
];

describe.each(ports)("the tools for files over %s", (_name, port) => {
	const withTools = (body: (call: ReturnType<typeof calling>) => Promise<void>) =>
		port((files) => body(calling(deletingFileTools(files, recorder().run))));

	it("offer the five tools and delete_file", async () => {
		await port(async (files) => {
			expect(Object.keys(deletingFileTools(files, recorder().run))).toEqual([
				"read_file",
				"write_file",
				"edit_file",
				"find_files",
				"search",
				"delete_file",
			]);
		});
	});

	it("read a file with its lines numbered, and say when there is none", async () => {
		await withTools(async (call) => {
			expect(await call("read_file", { path: "repo/docs/guide.md" })).toBe(
				"1\t# Guide\n2\t\n3\tFirst line.\n4\tSecond needle line.",
			);
			expect(await call("read_file", { path: "/workspace/repo/docs/guide.md", offset: 3 })).toBe(
				"3\tFirst line.\n4\tSecond needle line.",
			);
			await expect(call("read_file", { path: "repo/docs/missing.md" })).rejects.toThrow(
				"/workspace/repo/docs/missing.md does not exist.",
			);
			await expect(call("read_file", { path: "/etc/passwd" })).rejects.toThrow(
				"/etc/passwd is outside /workspace",
			);
		});
	});

	it("write a new file, in a directory that was not there, and read it back", async () => {
		await withTools(async (call) => {
			expect(
				await call("write_file", { path: "repo/notes/new/todo.md", content: "- one\n- two\n" }),
			).toBe("Wrote 12 bytes to /workspace/repo/notes/new/todo.md.");
			expect(await call("read_file", { path: "repo/notes/new/todo.md" })).toBe(
				"1\t- one\n2\t- two",
			);
			expect(await call("find_files", { pattern: "todo.md" })).toBe(
				"/workspace/repo/notes/new/todo.md\n",
			);
		});
	});

	it("edit a file where the text is, once, and refuse what is not there or there twice", async () => {
		await withTools(async (call) => {
			expect(
				await call("edit_file", {
					path: "repo/docs/guide.md",
					old_text: "First line.",
					new_text: "The first line.",
				}),
			).toBe("Replaced 1 place in /workspace/repo/docs/guide.md.");
			expect(await call("read_file", { path: "repo/docs/guide.md", offset: 3, limit: 1 })).toBe(
				"3\tThe first line.\n\n[Lines 3 to 3 of 4; read on from 4.]",
			);
			await expect(
				call("edit_file", { path: "repo/docs/guide.md", old_text: "absent", new_text: "x" }),
			).rejects.toThrow("The text to replace is not in /workspace/repo/docs/guide.md.");
			await expect(
				call("edit_file", { path: "repo/docs/guide.md", old_text: "line", new_text: "x" }),
			).rejects.toThrow("is in /workspace/repo/docs/guide.md 2 times");
			expect(
				await call("edit_file", {
					path: "repo/docs/guide.md",
					old_text: "line",
					new_text: "row",
					replace_all: true,
				}),
			).toBe("Replaced 2 places in /workspace/repo/docs/guide.md.");
		});
	});

	it("keep a file's carriage returns through an edit", async () => {
		await withTools(async (call) => {
			await call("edit_file", { path: "repo/windows.txt", old_text: "two", new_text: "2" });
			expect(await call("search", { pattern: "needle", path: "repo/windows.txt" })).toBe(
				"2:2 needle\r\n",
			);
		});
	});

	it("list files by a glob, sorted a part of the path at a time, hidden ones too", async () => {
		await withTools(async (call) => {
			expect(await call("find_files", { pattern: "*.md" })).toBe(
				[
					"/workspace/repo/README.md",
					"/workspace/repo/docs/api/reference.md",
					"/workspace/repo/docs/guide.md",
					"",
				].join("\n"),
			);
			// A directory's files come before the file named like it with an ending, and capitals
			// before small letters.
			expect(await call("find_files", { pattern: "**/*.ts", path: "repo/src" })).toBe(
				[
					"/workspace/repo/src/Big.ts",
					"/workspace/repo/src/index.ts",
					"/workspace/repo/src/util/text.ts",
					"/workspace/repo/src/util.ts",
					"",
				].join("\n"),
			);
			expect(await call("find_files", { pattern: "CODE*" })).toBe(
				"/workspace/repo/.github/CODEOWNERS\n",
			);
			// A glob with a slash holds from the sandbox's root, where the repository is `repo`.
			expect(await call("find_files", { pattern: "repo/src/*.ts" })).toBe(
				[
					"/workspace/repo/src/Big.ts",
					"/workspace/repo/src/index.ts",
					"/workspace/repo/src/util.ts",
					"",
				].join("\n"),
			);
			expect(await call("find_files", { pattern: "{index,util}.ts" })).toBe(
				["/workspace/repo/src/index.ts", "/workspace/repo/src/util.ts", ""].join("\n"),
			);
			// The file itself has to match: a directory's name takes none of what is in it.
			expect(await call("find_files", { pattern: "util" })).toBe("No files match.");
			expect(await call("find_files", { pattern: "*.rs" })).toBe("No files match.");
		});
	});

	it("search for a word and list each line as path:line:text", async () => {
		await withTools(async (call) => {
			expect(await call("search", { pattern: "needle", path: "repo/docs" })).toBe(
				"/workspace/repo/docs/guide.md:4:Second needle line.\n",
			);
			expect(await call("search", { pattern: "needle", glob: "*.md" })).toBe(
				[
					"/workspace/repo/README.md:3:A needle in the readme.",
					"/workspace/repo/docs/guide.md:4:Second needle line.",
					"",
				].join("\n"),
			);
			expect(await call("search", { pattern: "haystack" })).toBe("No line matches.");
			expect(await call("search", { pattern: "needle", glob: "*.rs" })).toBe("No line matches.");
		});
	});

	it("search hidden files, and regardless of case when asked", async () => {
		await withTools(async (call) => {
			expect(await call("search", { pattern: "needle-team" })).toBe(
				"/workspace/repo/.github/CODEOWNERS:1:* @acme/needle-team\n",
			);
			expect(await call("search", { pattern: "needle", path: "repo/src" })).toBe(
				"No line matches.",
			);
			expect(await call("search", { pattern: "needle", path: "repo/src", ignore_case: true })).toBe(
				"/workspace/repo/src/Big.ts:1:// NEEDLE in capitals\n",
			);
		});
	});

	it("leave the path out for one file, a long line's text out, and a mark off the first line", async () => {
		await withTools(async (call) => {
			expect(await call("search", { pattern: "needle", path: "repo/long.txt" })).toBe(
				"1:[Omitted long matching line]\n2:short needle\n",
			);
			expect(await call("search", { pattern: "needle", glob: "long.txt" })).toBe(
				[
					"/workspace/repo/long.txt:1:[Omitted long matching line]",
					"/workspace/repo/long.txt:2:short needle",
					"",
				].join("\n"),
			);
			expect(await call("search", { pattern: "needle", path: "repo/marked.txt" })).toBe(
				"1:needle after a mark\n",
			);
			expect(await call("search", { pattern: "needle", path: "repo/windows.txt" })).toBe(
				"2:two needle\r\n",
			);
		});
	});

	it("delete a file, which is then neither read, listed nor searched", async () => {
		await withTools(async (call) => {
			expect(await call("delete_file", { path: "repo/docs/guide.md" })).toBe(
				"Deleted /workspace/repo/docs/guide.md.",
			);
			await expect(call("read_file", { path: "repo/docs/guide.md" })).rejects.toThrow(
				"/workspace/repo/docs/guide.md does not exist.",
			);
			expect(await call("find_files", { pattern: "*.md", path: "repo/docs" })).toBe(
				"/workspace/repo/docs/api/reference.md\n",
			);
			expect(await call("search", { pattern: "needle", path: "repo/docs" })).toBe(
				"No line matches.",
			);
			// Each says no in its own words, and names the file.
			await expect(call("delete_file", { path: "repo/docs/guide.md" })).rejects.toThrow(
				"/workspace/repo/docs/guide.md",
			);
			await expect(call("delete_file", { path: "repo/docs" })).rejects.toThrow("directory");
			await expect(call("delete_file", { path: "../etc/passwd" })).rejects.toThrow(
				"../etc/passwd is outside /workspace",
			);
		});
	});

	it("find what was written and search it, without a word of what it replaced", async () => {
		await withTools(async (call) => {
			await call("write_file", { path: "repo/README.md", content: "# Site\n\nNothing here.\n" });
			await call("write_file", { path: "repo/docs/fresh.md", content: "A fresh needle.\n" });
			expect(await call("search", { pattern: "needle", glob: "*.md" })).toBe(
				[
					"/workspace/repo/docs/fresh.md:1:A fresh needle.",
					"/workspace/repo/docs/guide.md:4:Second needle line.",
					"",
				].join("\n"),
			);
		});
	});

	it("refuse to look where nothing is", async () => {
		await withTools(async (call) => {
			await expect(call("find_files", { pattern: "*", path: "repo/absent" })).rejects.toThrow(
				"/workspace/repo/absent",
			);
			await expect(call("search", { pattern: "x", path: "repo/absent" })).rejects.toThrow(
				"/workspace/repo/absent",
			);
		});
	});
});

describe("a sandbox's port", () => {
	it("deletes a file with rm, and says what rm said when it does not", async () => {
		const sandbox = new MemorySandbox();
		const files = sandboxFiles(sandbox);
		sandbox.answers.push(
			{ exitCode: 0, output: "", timedOut: false },
			{ exitCode: 1, output: "rm: cannot remove 'it'\\''s.md': No such file\n", timedOut: false },
			{ exitCode: 1, output: "", timedOut: false },
			{ exitCode: 124, output: "", timedOut: true },
		);
		expect(await files.deleteFile("/workspace/a.txt")).toEqual({ deleted: true });
		expect(await files.deleteFile("/workspace/it's.md")).toEqual({
			error: "rm: cannot remove 'it'\\''s.md': No such file",
		});
		expect(await files.deleteFile("/workspace/b.txt")).toEqual({
			error: "/workspace/b.txt could not be deleted.",
		});
		expect(await files.deleteFile("/workspace/c.txt")).toEqual({
			error: "/workspace/c.txt was not deleted in time.",
		});
		expect(sandbox.commands.slice(0, 2)).toEqual([
			{ command: "rm -- '/workspace/a.txt'", cwd: "/workspace", timeoutSeconds: 60 },
			{ command: "rm -- '/workspace/it'\\''s.md'", cwd: "/workspace", timeoutSeconds: 60 },
		]);
	});

	it("takes ripgrep's exit with 1 and something printed for a complaint, not for nothing found", async () => {
		const sandbox = new MemorySandbox();
		const files = sandboxFiles(sandbox);
		sandbox.answers.push({
			exitCode: 1,
			output: "rg: a.txt: Permission denied\n",
			timedOut: false,
		});
		expect(await files.search({ pattern: "a", path: "/workspace", ignoreCase: false })).toEqual({
			error: "rg: a.txt: Permission denied",
		});
	});

	it("says ripgrep's words of itself, which the tools pass on to the model", async () => {
		const files = sandboxFiles(new MemorySandbox());
		expect(files.words).toBe(SANDBOX_FILE_WORDS);
		const tools = deletingFileTools(files, recorder().run);
		expect(tools.search?.description).toBe(SANDBOX_FILE_WORDS.search);
		expect(tools.find_files?.description).toBe(SANDBOX_FILE_WORDS.findFiles);
	});
});
