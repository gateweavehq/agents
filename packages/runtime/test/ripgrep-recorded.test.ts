import { FakeGit } from "@gateweave/agents-github/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CommandResult,
	type SearchQuery,
	type SearchResult,
	sandboxFiles,
} from "../src/sandbox-tools";
import { MemorySandbox } from "./fake-sandbox";
import {
	BRANCH,
	inConversation,
	RipgrepSandbox,
	repositoryOf,
	storeOver,
	useGitHub,
} from "./file-store-support";
import recorded from "./ripgrep/recorded.json";

// What the sandbox's own ripgrep answered, held against the two things that stand in for it.
//
// `ripgrep/recorded.json` is the output of the ripgrep in the sandbox's image (its version is in
// the file), run by `ripgrep/record.mjs` in that image over a small repository with the two
// command lines `sandboxFiles` writes. Nothing in it comes from this repository's code.
//
// What this shows:
// - The command lines recorded are the ones `sandboxFiles` writes today.
// - The tests' stand-in for ripgrep (`RipgrepSandbox`) answers every recorded command as ripgrep
//   did: exit code and output. So the shared suite (`file-ports.test.ts`), whose sandbox side is
//   that stand-in, compares the store with ripgrep's rules and not with the store's own.
// - The files store answers every recorded listing and search as ripgrep did, except where it
//   differs on purpose. Each difference is written out below with both answers.
//
// What it does not show: anything ripgrep does that no recorded case asks of it, such as a file
// that is not UTF-8 (a JSON file holds only text), symlinks, files over 256 KiB, or a regular
// expression, which the store does not take. The order of files in a search is not compared:
// ripgrep searches several at once and promises none.

afterEach(() => {
	vi.unstubAllGlobals();
});

const ROOT = "/workspace";
const GIT = `${ROOT}/repo/.git/`;

/** The listing without what lies in `.git`, which the stand-ins do not have. */
function withoutGit(output: string): string {
	return output
		.split("\n")
		.filter((line) => !line.startsWith(GIT))
		.join("\n");
}

/** A search's lines in one order, by file and then by line, since ripgrep promises none. */
function ordered(output: string): string {
	const lines = output.split("\n").filter((line) => line !== "");
	const key = (line: string) => {
		const [path = "", number = ""] = line.split(":");
		return { parts: path.split("/"), number: Number(number) };
	};
	lines.sort((one, other) => {
		const a = key(one);
		const b = key(other);
		for (let index = 0; index < Math.min(a.parts.length, b.parts.length); index++) {
			const left = a.parts[index] ?? "";
			const right = b.parts[index] ?? "";
			if (left !== right) return left < right ? -1 : 1;
		}
		return a.parts.length - b.parts.length || a.number - b.number;
	});
	return lines.map((line) => `${line}\n`).join("");
}

/** What the tools make of a command's result: `sandboxFiles`' own reading of it. */
async function reading(result: CommandResult): Promise<SearchResult> {
	const sandbox = new MemorySandbox();
	sandbox.answers.push(result);
	return sandboxFiles(sandbox).findFiles("*", ROOT);
}

function inOrder(result: SearchResult): SearchResult {
	return "found" in result && result.found !== null ? { found: ordered(result.found) } : result;
}

function standIn(tree: Record<string, string>): RipgrepSandbox {
	const sandbox = new RipgrepSandbox();
	for (const [path, content] of Object.entries(tree)) sandbox.files.set(`${ROOT}/${path}`, content);
	return sandbox;
}

/** The files store over the recorded files, checked out, then `body`. */
async function store(
	tree: Record<string, string>,
	body: (files: ReturnType<typeof storeOver>["store"]) => Promise<void>,
): Promise<void> {
	const fake = new FakeGit();
	await fake.seed(
		Object.fromEntries(
			Object.entries(tree).map(([path, content]) => [path.slice("repo/".length), content]),
		),
	);
	useGitHub(fake);
	await inConversation(async (storage) => {
		const files = storeOver(storage, fake).store;
		expect(await files.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: true });
		await body(files);
	});
}

const query = (found: { query: object }) => ({ ignoreCase: false, ...found.query }) as SearchQuery;

describe("the sandbox's ripgrep, as recorded", () => {
	it("was asked with the command lines the sandbox's port writes", async () => {
		expect(recorded.ripgrep).toMatch(/^ripgrep \d+\.\d+\.\d+/);
		const sandbox = new MemorySandbox();
		const files = sandboxFiles(sandbox);
		for (const found of recorded.finds) {
			sandbox.answers.push({
				exitCode: found.exitCode,
				output: found.output,
				timedOut: false,
			});
			await files.findFiles(found.pattern, found.directory);
		}
		for (const found of recorded.searches) await files.search(query(found));
		expect(sandbox.commands.map((ran) => ran.command)).toEqual([
			...recorded.finds.flatMap((found) => [
				found.command,
				...found.filters.map((filter) => filter.command),
			]),
			...recorded.searches.map((found) => found.command),
		]);
		expect(sandbox.commands.every((ran) => ran.cwd === ROOT)).toBe(true);
	});

	it("is what the tests' stand-in answers, exit code and output, for every listing", async () => {
		const sandbox = standIn(recorded.tree);
		for (const found of recorded.finds) {
			const ran = await sandbox.run(found.command, ROOT, 60);
			expect({ command: found.command, exitCode: ran.exitCode, output: ran.output }).toEqual({
				command: found.command,
				exitCode: found.exitCode,
				output: withoutGit(found.output),
			});
		}
	});

	it("is what the tests' stand-in answers, exit code and output, for every search", async () => {
		const sandbox = standIn(recorded.tree);
		for (const found of recorded.searches) {
			const ran = await sandbox.run(found.command, ROOT, 60);
			expect({
				command: found.command,
				exitCode: ran.exitCode,
				output: ordered(ran.output),
			}).toEqual({
				command: found.command,
				exitCode: found.exitCode,
				output: ordered(found.output),
			});
		}
	});

	it("omits a matching line by its bytes with the newline that ends it", () => {
		const lines = (path: string) =>
			recorded.searches
				.find((found) => found.query.path === `${ROOT}/repo/lengths/${path}`)
				?.output.split("\n")
				.filter((line) => line !== "")
				.map((line) => (line.includes("[Omitted long matching line]") ? "omitted" : "shown"));
		// 498, 499, 500 and 501 bytes before the newline.
		expect(lines("lf.txt")).toEqual(["shown", "shown", "omitted", "omitted"]);
		// 497 to 500 bytes before a carriage return and the newline.
		expect(lines("crlf.txt")).toEqual(["shown", "shown", "omitted", "omitted"]);
		// With no newline after it, a line may be one byte longer.
		expect(lines("last-499.txt")).toEqual(["shown"]);
		expect(lines("last-500.txt")).toEqual(["shown"]);
		// 499 and 502 bytes in three-byte characters, then 177 characters that are 517 bytes.
		expect(lines("euro.txt")).toEqual(["shown", "omitted", "omitted"]);
	});
});

describe("the files store, beside the recorded ripgrep", () => {
	/** Where the store's listing is not ripgrep's, with what each answers. */
	const listedOtherwise: Record<string, { ripgrep: SearchResult; store: SearchResult }> = {
		// A glob with a slash holds from the sandbox's root for ripgrep. The store also holds it
		// from the repository's root and from the directory looked in.
		"src/*.ts in /workspace": {
			ripgrep: { found: null },
			store: {
				found:
					"/workspace/repo/src/Big.ts\n/workspace/repo/src/index.ts\n/workspace/repo/src/util.ts\n",
			},
		},
		"src/*.ts in /workspace/repo": {
			ripgrep: { found: null },
			store: {
				found:
					"/workspace/repo/src/Big.ts\n/workspace/repo/src/index.ts\n/workspace/repo/src/util.ts\n",
			},
		},
		"src/**/*.tsx in /workspace/repo": {
			ripgrep: { found: null },
			store: {
				found: "/workspace/repo/src/pages/[id].tsx\n/workspace/repo/src/pages/index.tsx\n",
			},
		},
		"util/*.ts in /workspace/repo/src": {
			ripgrep: { found: null },
			store: { found: "/workspace/repo/src/util/text.ts\n" },
		},
		// Both refuse and name the path, each in its own words.
		"* in /workspace/repo/absent": {
			ripgrep: {
				error:
					"/workspace/repo/absent: IO error for operation on /workspace/repo/absent: No such file or directory (os error 2)",
			},
			store: { error: "/workspace/repo/absent does not exist." },
		},
	};

	it("lists what ripgrep listed for every recorded glob, but where it differs on purpose", async () => {
		await store(recorded.tree, async (files) => {
			const differed: string[] = [];
			for (const found of recorded.finds) {
				const name = `${found.pattern} in ${found.directory}`;
				const ripgrep = await reading({
					exitCode: found.exitCode,
					output: withoutGit(found.output),
					timedOut: false,
				});
				const answered = await files.findFiles(found.pattern, found.directory);
				const otherwise = listedOtherwise[name];
				if (otherwise) {
					differed.push(name);
					expect({ name, ripgrep, store: answered }).toEqual({ name, ...otherwise });
				} else {
					expect({ name, store: answered }).toEqual({ name, store: ripgrep });
				}
			}
			expect(differed.sort()).toEqual(Object.keys(listedOtherwise).sort());
		});
	});

	/** Where the store's search is not ripgrep's, with what each answers. */
	const searchedOtherwise: Record<string, { ripgrep: SearchResult; store: SearchResult }> = {
		// Named itself, a file with a NUL byte: ripgrep says that it matched and shows nothing,
		// the store says why it does not look.
		"/workspace/repo/zero.dat": {
			ripgrep: { found: 'binary file matches (found "\\0" byte around offset 8)\n' },
			store: { error: "/workspace/repo/zero.dat is not text." },
		},
		"/workspace/repo/absent": {
			ripgrep: { error: "/workspace/repo/absent: No such file or directory (os error 2)" },
			store: { error: "/workspace/repo/absent does not exist." },
		},
	};

	it("finds the lines ripgrep found for every recorded search, but where it differs on purpose", async () => {
		await store(recorded.tree, async (files) => {
			for (const found of recorded.searches) {
				const name = JSON.stringify(found.query);
				const ripgrep = inOrder(
					await reading({ exitCode: found.exitCode, output: found.output, timedOut: false }),
				);
				const answered = inOrder(await files.search(query(found)));
				const otherwise = searchedOtherwise[found.query.path];
				if (otherwise) {
					expect({ name, ripgrep, store: answered }).toEqual({ name, ...otherwise });
				} else {
					expect({ name, store: answered }).toEqual({ name, store: ripgrep });
				}
			}
		});
	});

	it("reads a glob's braces, sets and bytes as ripgrep read them, over names that are not plain", async () => {
		const { tree, finds } = recorded.naming;
		// What ripgrep answered, so that a new recording that says otherwise is seen here first.
		const answered = Object.fromEntries(
			finds.map((found) => [found.pattern, found.output.replaceAll("/workspace/repo/", "")]),
		);
		expect(answered).toMatchObject({
			// Braces in a set are bytes of the set.
			"[{}].txt": "{.txt\n}.txt\n",
			// One branch with a slash holds every branch from where the path starts.
			"{repo/src/index.ts,README.md}": "src/index.ts\n",
			"{repo/README.md,index.ts}": "README.md\n",
			// A name is matched as bytes: `é` is two and `😀` four.
			"?.txt": "a.txt\n{.txt\n}.txt\n",
			"??.txt": "[].txt\né.txt\n",
			"???.txt": "",
			"????.txt": "éé.txt\n😀.txt\n",
			"[é].txt": "",
			"[!a].txt": "{.txt\n}.txt\n",
		});

		// The tests' stand-in, which reads globs with the store's own reader.
		const sandbox = standIn(tree);
		for (const found of finds) {
			const ran = await sandbox.run(found.command, ROOT, 60);
			expect({ command: found.command, exitCode: ran.exitCode, output: ran.output }).toEqual({
				command: found.command,
				exitCode: found.exitCode,
				output: withoutGit(found.output),
			});
		}

		// The store. It also holds a glob with a slash from the repository's root, where the
		// branch without one finds the file ripgrep leaves out; never the nested one.
		const both = { found: "/workspace/repo/README.md\n/workspace/repo/src/index.ts\n" };
		const otherwise: Record<string, SearchResult> = {
			"{repo/src/index.ts,README.md}": both,
			"{README.md,repo/src/index.ts}": both,
		};
		await store(tree, async (files) => {
			for (const found of finds) {
				const ripgrep = await reading({
					exitCode: found.exitCode,
					output: withoutGit(found.output),
					timedOut: false,
				});
				expect({
					pattern: found.pattern,
					store: await files.findFiles(found.pattern, found.directory),
				}).toEqual({ pattern: found.pattern, store: otherwise[found.pattern] ?? ripgrep });
			}
		});
	});

	it("lists and searches as the words say: no .git, and nothing git ignores, though the glob matches it", async () => {
		const { tree, finds, searches } = recorded.ignoring;
		const listed = finds[0]?.output ?? "";
		const searched = searches[0]?.output ?? "";
		// ripgrep, with no glob of the model's: only the file no rule names.
		expect(searched).toBe("/workspace/repo/kept.txt:1:a needle\n");
		// ripgrep's own listing has them after all: a glob given outranks the ignore rules, and
		// `.git` too, so the port drops what lies in `.git` itself and asks git about the rest.
		expect(listed).toContain("/workspace/repo/debug.log\n");
		expect(listed).toContain("/workspace/repo/build/out.txt\n");
		expect(listed).toContain("/workspace/repo/.git/HEAD\n");
		expect(finds[0]?.filters).toEqual([
			{
				command:
					"git -C '/workspace/repo' check-ignore -- '.gitignore' 'build/out.txt' 'debug.log' 'kept.txt'",
				exitCode: 0,
				output: "build/out.txt\ndebug.log\n",
			},
		]);

		// The port, over the recorded exchange: the two ignored files are gone.
		const sandbox = new MemorySandbox();
		sandbox.answers.push(
			{ exitCode: finds[0]?.exitCode ?? 0, output: listed, timedOut: false },
			...(finds[0]?.filters ?? []).map((filter) => ({
				exitCode: filter.exitCode,
				output: filter.output,
				timedOut: false,
			})),
		);
		expect(await sandboxFiles(sandbox).findFiles("*", ROOT)).toEqual({
			found: "/workspace/repo/.gitignore\n/workspace/repo/kept.txt\n",
		});

		await store(tree, async (files) => {
			// The store: every file of the commit, whatever the rules say, and no .git.
			expect(await files.findFiles("*", ROOT)).toEqual({ found: withoutGit(listed) });
			expect(
				inOrder(await files.search({ pattern: "needle", path: ROOT, ignoreCase: false })),
			).toEqual({
				found: [
					"/workspace/repo/build/out.txt:1:a needle in a build\n",
					"/workspace/repo/debug.log:1:a needle in a log\n",
					"/workspace/repo/kept.txt:1:a needle\n",
				].join(""),
			});
		});
	});
});
