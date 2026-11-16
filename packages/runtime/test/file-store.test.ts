import { FakeGit } from "@gateweave/agents-github/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CHANGE_TOO_LARGE,
	FILE_STORE_LIMITS,
	FILE_STORE_WORDS,
	type FileStore,
	TOO_LARGE,
} from "../src/file-store";
import { deletingFileTools, SANDBOX_FILE_WORDS, sandboxTools } from "../src/sandbox-tools";
import { MemorySandbox } from "./fake-sandbox";
import {
	AUTHOR,
	BRANCH,
	calling,
	inConversation,
	recorder,
	repositoryOf,
	rowCounts,
	storedText,
	storeOver,
	useGitHub,
} from "./file-store-support";

// The files store against a stand-in for GitHub that refuses what GitHub refuses
// (`@gateweave/agents-github/testing`). No request here reaches the real one.

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const REPO = "/workspace/repo";

const FILES: Record<string, string> = {
	"README.md": "# Site\n\nA needle in the readme.\n",
	"docs/guide.md": "# Guide\n\nSecond needle line.\n",
	"docs/api/reference.md": "# Reference\n\nA needle too.\n",
	"src/index.ts": "export const needle = 1;\n",
	"src/util.ts": "export const other = 2;\n",
};

/** A repository seeded with `files`, checked out into a conversation's storage, then `body`. */
async function checkedOut(
	files: Record<string, string | Uint8Array>,
	body: (at: {
		fake: FakeGit;
		store: FileStore;
		storage: DurableObjectStorage;
		asked: { repository: string; access: "read" | "write" }[];
	}) => Promise<void>,
	seed: Parameters<FakeGit["seed"]>[1] = {},
): Promise<void> {
	const fake = new FakeGit();
	await fake.seed(files, seed);
	useGitHub(fake);
	await inConversation(async (storage) => {
		const { store, asked } = storeOver(storage, fake);
		expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: true });
		fake.requests.length = 0;
		await body({ fake, store, storage, asked });
	});
}

function found(result: { found: string | null } | { error: string }): string | null {
	if ("error" in result) throw new Error(result.error);
	return result.found;
}

function content(result: { content: string } | { error: string }): string {
	if ("error" in result) throw new Error(result.error);
	return result.content;
}

describe("checking a repository out with no machine", () => {
	it("asks for the branch and its tree, and keeps the listing whole, not a row a file", async () => {
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		await inConversation(async (storage) => {
			const { store, asked } = storeOver(storage, fake);
			expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: true });
			expect(fake.requests).toHaveLength(2);
			expect(fake.requests[0]).toBe("GET /repos/acme/site/branches/main");
			expect(fake.requests[1]).toMatch(/^GET \/repos\/acme\/site\/git\/trees\/[0-9a-f]{40}$/);
			expect(asked).toEqual([{ repository: "acme/site", access: "read" }]);
			expect(rowCounts(storage)).toEqual({ checkout: 1, listing: 1, blobs: 0, changes: 0 });

			// The listing answers a glob with no word to GitHub.
			expect(found(await store.findFiles("*.md", REPO))).toBe(
				`${REPO}/README.md\n${REPO}/docs/api/reference.md\n${REPO}/docs/guide.md\n`,
			);
			expect(fake.requests).toHaveLength(2);
		});
	});

	it("is there already on a later turn, which asks GitHub nothing and keeps its base", async () => {
		await checkedOut(FILES, async ({ fake, storage }) => {
			await fake.push("main", "README.md", "# Moved on\n");
			const later = storeOver(storage, fake).store;
			expect(await later.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: false });
			expect(fake.requests).toEqual([]);
			// The files are the ones of the commit first read, not of the branch as it is now.
			expect(content(await later.readFile(`${REPO}/README.md`))).toBe(FILES["README.md"]);
		});
	});

	it("keeps the repository it first checked out", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			const other = { ...repositoryOf(fake), name: "other", externalId: "9" };
			expect(await store.checkout(other, BRANCH)).toEqual({
				error:
					"This conversation has acme/site checked out. Start a new conversation to work on acme/other.",
			});
		});
	});

	it("refuses a tree GitHub cut short, and one of too many files", async () => {
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		fake.listingLimit = 3;
		await inConversation(async (storage) => {
			const { store } = storeOver(storage, fake);
			expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ error: TOO_LARGE });
			expect(rowCounts(storage)).toEqual({ checkout: 0, listing: 0, blobs: 0, changes: 0 });
			expect(await store.readFile(`${REPO}/README.md`)).toEqual({
				error: "No repository is checked out here.",
			});
		});

		const large = new FakeGit();
		const many: Record<string, string> = {};
		// Few distinct blobs, so the fake hashes little; every path is an entry of its own.
		for (let index = 0; index <= FILE_STORE_LIMITS.files; index++) many[`f${index}.txt`] = "same\n";
		await large.seed(many);
		useGitHub(large);
		await inConversation(async (storage) => {
			const { store } = storeOver(storage, large);
			expect(await store.checkout(repositoryOf(large), BRANCH)).toEqual({ error: TOO_LARGE });
			expect(rowCounts(storage).checkout).toBe(0);
		});
	});

	it("takes a repository of exactly as many files as are allowed, in a few rows", async () => {
		const fake = new FakeGit();
		const many: Record<string, string> = {};
		for (let index = 0; index < FILE_STORE_LIMITS.files; index++) {
			many[`dir${index % 50}/file-${index}.txt`] = `text ${index % 7}\n`;
		}
		await fake.seed(many);
		useGitHub(fake);
		await inConversation(async (storage) => {
			const { store } = storeOver(storage, fake);
			expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: true });
			const rows = rowCounts(storage);
			expect(rows.listing).toBeGreaterThanOrEqual(1);
			expect(rows.listing).toBeLessThanOrEqual(8);
			expect(found(await store.findFiles("file-19999.txt", REPO))).toBe(
				`${REPO}/dir49/file-19999.txt\n`,
			);
		});
	});
});

describe("reading", () => {
	it("fetches that one blob the first time, and none after", async () => {
		await checkedOut(FILES, async ({ fake, store, storage, asked }) => {
			expect(content(await store.readFile(`${REPO}/docs/guide.md`))).toBe(FILES["docs/guide.md"]);
			expect(fake.requests).toHaveLength(1);
			expect(fake.requests[0]).toMatch(/^GET \/repos\/acme\/site\/git\/blobs\/[0-9a-f]{40}$/);
			expect(asked.at(-1)).toEqual({ repository: "acme/site", access: "read" });
			expect(rowCounts(storage).blobs).toBe(1);

			expect(content(await store.readFile(`${REPO}/docs/guide.md`))).toBe(FILES["docs/guide.md"]);
			expect(fake.requests).toHaveLength(1);
		});
	});

	it("says what is not a file in words: nothing there, a directory, outside the repository", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			expect(await store.readFile(`${REPO}/docs/absent.md`)).toEqual({
				error: `${REPO}/docs/absent.md does not exist.`,
			});
			expect(await store.readFile(`${REPO}/docs`)).toEqual({
				error: `${REPO}/docs is a directory. List it with find_files.`,
			});
			expect(await store.readFile("/workspace/notes.md")).toEqual({
				error:
					"/workspace/notes.md is outside /workspace/repo, which holds the repository and is all there is here.",
			});
			expect(fake.requests).toEqual([]);
		});
	});

	it("lists a file over 256 KiB, a binary file and a symlink, and reads none of them", async () => {
		const large = `${"0123456789abcdef".repeat(16 * 1024)}tail needle\n`;
		const files = {
			...FILES,
			"data/large.txt": large,
			"data/logo.bin": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
			"data/latin.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
		};
		await checkedOut(
			files,
			async ({ fake, store }) => {
				expect(found(await store.findFiles("*", `${REPO}/data`))).toBe(
					`${REPO}/data/large.txt\n${REPO}/data/latin.txt\n${REPO}/data/link.md\n${REPO}/data/logo.bin\n`,
				);
				expect(await store.readFile(`${REPO}/data/large.txt`)).toEqual({
					error: `${REPO}/data/large.txt is 257 KiB, over what can be read here.`,
				});
				// Too large is known from the listing: nothing was asked.
				expect(fake.requests).toEqual([]);
				expect(await store.readFile(`${REPO}/data/logo.bin`)).toEqual({
					error: `${REPO}/data/logo.bin is not text.`,
				});
				// Bytes that are not UTF-8 cannot be pushed back as text, so they are not text here.
				expect(await store.readFile(`${REPO}/data/latin.txt`)).toEqual({
					error: `${REPO}/data/latin.txt is not text.`,
				});
				expect(await store.readFile(`${REPO}/data/link.md`)).toEqual({
					error: `${REPO}/data/link.md is a symlink to ../docs/guide.md.`,
				});
				// A file that is not text is asked for once.
				const asked = fake.requests.length;
				await store.readFile(`${REPO}/data/logo.bin`);
				expect(fake.requests).toHaveLength(asked);

				// None of them is written over.
				expect(await store.writeFile(`${REPO}/data/logo.bin`, "text\n")).toEqual({
					error: `${REPO}/data/logo.bin is not text, and is not written over.`,
				});
				expect(await store.writeFile(`${REPO}/data/link.md`, "text\n")).toEqual({
					error: `${REPO}/data/link.md is a symlink, which is left as it is.`,
				});
				expect(await store.deleteFile(`${REPO}/data/link.md`)).toEqual({
					error: `${REPO}/data/link.md is a symlink, which is left as it is.`,
				});
			},
			{ symlinks: { "data/link.md": "../docs/guide.md" } },
		);
	});
});

describe("searching", () => {
	it("fetches only the files under its path and glob, in one request, then holds them", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			expect(
				found(await store.search({ pattern: "needle", path: `${REPO}/docs`, ignoreCase: false })),
			).toBe(
				`${REPO}/docs/api/reference.md:3:A needle too.\n${REPO}/docs/guide.md:3:Second needle line.\n`,
			);
			expect(fake.requests).toEqual(["POST /graphql"]);
			expect(rowCounts(storage).blobs).toBe(2);

			// The same search again asks nothing; a wider one asks only for what is new.
			await store.search({ pattern: "needle", path: `${REPO}/docs`, ignoreCase: false });
			expect(fake.requests).toHaveLength(1);
			expect(
				found(
					await store.search({ pattern: "needle", path: REPO, glob: "*.ts", ignoreCase: false }),
				),
			).toBe(`${REPO}/src/index.ts:1:export const needle = 1;\n`);
			expect(fake.requests).toHaveLength(2);
			expect(rowCounts(storage).blobs).toBe(4);
		});
	});

	it("refuses a search that would fetch more than 500 files, and fetches none", async () => {
		const files: Record<string, string> = { "docs/guide.md": "a needle\n" };
		for (let index = 0; index <= FILE_STORE_LIMITS.searchFetched; index++) {
			files[`pages/page-${index}.md`] = `page ${index}\n`;
		}
		await checkedOut(files, async ({ fake, store, storage }) => {
			expect(await store.search({ pattern: "needle", path: REPO, ignoreCase: false })).toEqual({
				error: "That would read 502 files. Give a path or a glob.",
			});
			expect(fake.requests).toEqual([]);
			expect(rowCounts(storage).blobs).toBe(0);

			// A path narrows it, and so does a glob.
			expect(
				found(await store.search({ pattern: "needle", path: `${REPO}/docs`, ignoreCase: false })),
			).toBe(`${REPO}/docs/guide.md:1:a needle\n`);
			expect(
				found(
					await store.search({
						pattern: "page 7",
						path: REPO,
						glob: "page-7*.md",
						ignoreCase: false,
					}),
				),
			).toBe(
				`${REPO}/pages/page-7.md:1:page 7\n${REPO}/pages/page-70.md:1:page 70\n${REPO}/pages/page-71.md:1:page 71\n${REPO}/pages/page-72.md:1:page 72\n${REPO}/pages/page-73.md:1:page 73\n${REPO}/pages/page-74.md:1:page 74\n${REPO}/pages/page-75.md:1:page 75\n${REPO}/pages/page-76.md:1:page 76\n${REPO}/pages/page-77.md:1:page 77\n${REPO}/pages/page-78.md:1:page 78\n${REPO}/pages/page-79.md:1:page 79\n`,
			);
			// Eleven files, fetched in one request.
			expect(fake.requests).toEqual(["POST /graphql", "POST /graphql"]);
		});
	});

	it("takes the text as it is written, never as a regular expression", async () => {
		const files = {
			"a.txt": "price is 4.50 (net)\nprice is 4x50 [net]\n^start$ and a|b\n(a+)+$\n",
		};
		await checkedOut(files, async ({ store }) => {
			const search = async (pattern: string) =>
				found(await store.search({ pattern, path: `${REPO}/a.txt`, ignoreCase: false }));
			expect(await search("4.50")).toBe("1:price is 4.50 (net)\n");
			expect(await search("(net)")).toBe("1:price is 4.50 (net)\n");
			expect(await search("[net]")).toBe("2:price is 4x50 [net]\n");
			expect(await search("^start$")).toBe("3:^start$ and a|b\n");
			expect(await search("a|b")).toBe("3:^start$ and a|b\n");
			expect(await search("(a+)+$")).toBe("4:(a+)+$\n");
			expect(await search(".*")).toBeNull();
			expect(await store.search({ pattern: "is\n4", path: REPO, ignoreCase: false })).toEqual({
				error: "The text to find cannot span lines: it is looked for within one.",
			});
		});
		// The tool says so to the model, where a sandbox's says ripgrep and a regular expression.
		expect(FILE_STORE_WORDS.search).toContain("literal, not a regular expression");
		expect(FILE_STORE_WORDS.pattern).toContain("not a regular expression");
		expect(SANDBOX_FILE_WORDS.pattern).toBe("The regular expression (Rust syntax)");
	});

	it("skips what is not text, what is too large and symlinks, and searches hidden files", async () => {
		const files = {
			".config/settings.json": '{ "needle": true }\n',
			"image.bin": new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]),
			"large.txt": `${"needle ".repeat(40_000)}\n`,
			"plain.txt": "a needle\n",
		};
		await checkedOut(
			files,
			async ({ store, storage }) => {
				expect(
					found(await store.search({ pattern: "needle", path: REPO, ignoreCase: false })),
				).toBe(
					`${REPO}/.config/settings.json:1:{ "needle": true }\n${REPO}/plain.txt:1:a needle\n`,
				);
				// The large file and the symlink were not fetched; the binary one is known as unread.
				expect(rowCounts(storage).blobs).toBe(3);
				// Named itself, a file that cannot be searched says why.
				expect(
					await store.search({ pattern: "needle", path: `${REPO}/image.bin`, ignoreCase: false }),
				).toEqual({ error: `${REPO}/image.bin is not text.` });
				expect(
					await store.search({ pattern: "needle", path: `${REPO}/large.txt`, ignoreCase: false }),
				).toEqual({ error: `${REPO}/large.txt is 274 KiB, over what can be read here.` });
			},
			{ symlinks: { "link.txt": "plain.txt" } },
		);
	});

	it("reads a file again as bytes when GitHub's text of it lost the byte order mark", async () => {
		const files = { "marked.txt": "﻿a needle\r\n", "plain.txt": "another needle\n" };
		await checkedOut(files, async ({ fake, store }) => {
			fake.dropsMark = true;
			expect(found(await store.search({ pattern: "needle", path: REPO, ignoreCase: false }))).toBe(
				`${REPO}/marked.txt:1:a needle\r\n${REPO}/plain.txt:1:another needle\n`,
			);
			expect(fake.requests).toHaveLength(2);
			expect(fake.requests[0]).toBe("POST /graphql");
			expect(fake.requests[1]).toMatch(/\/git\/blobs\/[0-9a-f]{40}$/);
			// What is held is the file's own bytes, mark and all.
			expect(content(await store.readFile(`${REPO}/marked.txt`))).toBe("﻿a needle\r\n");
			expect(fake.requests).toHaveLength(2);
		});
	});

	it("reads at most 25 such files again in one search, and says how many it left", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 27; index++) {
			files[`marked-${String(index).padStart(2, "0")}.txt`] = `﻿needle ${index}\n`;
		}
		await checkedOut(files, async ({ fake, store }) => {
			fake.dropsMark = true;
			const first = found(await store.search({ pattern: "needle", path: REPO, ignoreCase: false }));
			expect(first?.split("\n").filter((line) => line.includes(":1:needle"))).toHaveLength(25);
			expect(
				first?.endsWith(
					"[2 files were not searched: GitHub's text of them could not be checked this time. Search again to go on.]\n",
				),
			).toBe(true);
			expect(fake.requests).toHaveLength(26);

			const second = found(
				await store.search({ pattern: "needle", path: REPO, ignoreCase: false }),
			);
			expect(second?.split("\n").filter((line) => line.includes(":1:needle"))).toHaveLength(27);
			expect(second).not.toContain("not searched");
			expect(fake.requests).toHaveLength(29);
		});
	});

	it("takes a glob with a slash from the repository's root and from the directory searched", async () => {
		await checkedOut(FILES, async ({ store }) => {
			expect(found(await store.findFiles("docs/**/*.md", REPO))).toBe(
				`${REPO}/docs/api/reference.md\n${REPO}/docs/guide.md\n`,
			);
			expect(found(await store.findFiles("api/*.md", `${REPO}/docs`))).toBe(
				`${REPO}/docs/api/reference.md\n`,
			);
			expect(found(await store.findFiles("docs/*.md", "/workspace"))).toBe(
				`${REPO}/docs/guide.md\n`,
			);
			expect(await store.findFiles("!*.md", REPO)).toEqual({
				error: "A glob that begins with ! leaves files out, which is not done here.",
			});
			expect(await store.findFiles("*", "/workspace/elsewhere")).toEqual({
				error: "/workspace/elsewhere does not exist.",
			});
		});
	});

	it("clips a long answer as a command's output is clipped", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 600; index++) {
			files[`docs/a-rather-long-directory-name/page-${String(index).padStart(4, "0")}.md`] = "x\n";
		}
		await checkedOut(files, async ({ store }) => {
			const listed = found(await store.findFiles("*.md", REPO)) ?? "";
			expect(listed).toContain("bytes of output left out here]");
			expect(listed.startsWith(`${REPO}/docs/a-rather-long-directory-name/page-0000.md\n`)).toBe(
				true,
			);
			expect(listed.endsWith("page-0599.md\n")).toBe(true);
			expect(new TextEncoder().encode(listed).length).toBeLessThan(31_000);
		});
	});

	it("keeps at most what it may hold, the oldest going first", async () => {
		const files = { "a.txt": "a".repeat(60), "b.txt": "b".repeat(60), "c.txt": "c".repeat(60) };
		const held = FILE_STORE_LIMITS.heldBytes;
		FILE_STORE_LIMITS.heldBytes = 130;
		try {
			await checkedOut(files, async ({ fake, store, storage }) => {
				for (const name of ["a.txt", "b.txt", "c.txt"]) await store.readFile(`${REPO}/${name}`);
				expect(fake.requests).toHaveLength(3);
				const bytes = storage.sql
					.exec<{ bytes: number }>(
						"SELECT sum(size) AS bytes FROM file_blobs WHERE bytes IS NOT NULL",
					)
					.one().bytes;
				expect(bytes).toBe(120);
				// The first went, and is fetched again; the last is still held.
				await store.readFile(`${REPO}/c.txt`);
				expect(fake.requests).toHaveLength(3);
				expect(content(await store.readFile(`${REPO}/a.txt`))).toBe(files["a.txt"]);
				expect(fake.requests).toHaveLength(4);
				// A search that would look through more than is held at once is refused, and fetches none.
				expect(await store.search({ pattern: "a", path: REPO, ignoreCase: false })).toEqual({
					error: expect.stringContaining("more than is held at once"),
				});
				expect(fake.requests).toHaveLength(4);
			});
		} finally {
			FILE_STORE_LIMITS.heldBytes = held;
		}
	});
});

describe("writing", () => {
	it("keeps a change as bytes beside the blob it replaces, and drops one that changes nothing", async () => {
		await checkedOut(FILES, async ({ store, storage }) => {
			expect(await store.writeFile(`${REPO}/README.md`, "# Changed\n")).toEqual({ written: 10 });
			expect(await store.writeFile(`${REPO}/docs/new.md`, "new\n")).toEqual({ written: 4 });
			const rows = storage.sql
				.exec<{ path: string; original: string | null; size: number }>(
					"SELECT path, original, size FROM file_changes ORDER BY path",
				)
				.toArray();
			expect(rows).toEqual([
				{ path: "README.md", original: expect.stringMatching(/^[0-9a-f]{40}$/), size: 10 },
				{ path: "docs/new.md", original: null, size: 4 },
			]);
			// Written back as it was, it is no longer a change.
			await store.writeFile(`${REPO}/README.md`, FILES["README.md"] ?? "");
			expect(rowCounts(storage).changes).toBe(1);
		});
	});

	it("refuses paths that cannot be in a repository, or cannot be changed from here", async () => {
		await checkedOut(FILES, async ({ store, storage }) => {
			const write = (path: string) => store.writeFile(path, "x\n");
			expect(await write(`${REPO}/.git/config`)).toEqual({
				error: `${REPO}/.git/config is inside .git, or a name that some file systems read as .git.`,
			});
			expect(await write(`${REPO}/.github/workflows/ci.yml`)).toEqual({
				error: `${REPO}/.github/workflows/ci.yml is a workflow, which is not changed from here: GitHub takes one only from an app with the Workflows permission.`,
			});
			expect(await write(`${REPO}/docs`)).toEqual({ error: `${REPO}/docs is a directory.` });
			expect(await write(REPO)).toEqual({ error: `${REPO} is a directory.` });
			expect(await write(`${REPO}/README.md/inside.md`)).toEqual({
				error: `${REPO}/README.md/inside.md is under ${REPO}/README.md, which is a file in the repository; a file does not become a directory in one change.`,
			});
			expect(await write("/workspace/scratch.txt")).toEqual({
				error:
					"/workspace/scratch.txt is outside /workspace/repo, which holds the repository and is all there is here.",
			});
			await write(`${REPO}/fresh`);
			expect(await write(`${REPO}/fresh/inside.md`)).toEqual({
				error: `A part of ${REPO}/fresh/inside.md is a file, not a directory.`,
			});
			expect(await store.writeFile(`${REPO}/half.txt`, "\uD83D")).toEqual({
				error: `${REPO}/half.txt would hold text that is not Unicode: half of a surrogate pair.`,
			});
			expect(rowCounts(storage).changes).toBe(1);
		});
	});

	it("refuses a file over 1 MiB, and a change of more than 500 files or 20 MB", async () => {
		await checkedOut(FILES, async ({ store, storage }) => {
			expect(await store.writeFile(`${REPO}/big.txt`, "€".repeat(400_000))).toEqual({
				error: `${REPO}/big.txt would be 1172 KiB, over what can be written here (1024 KiB).`,
			});
			for (let index = 0; index < FILE_STORE_LIMITS.changedFiles - 1; index++) {
				expect(await store.writeFile(`${REPO}/many/file-${index}.txt`, "x\n")).toEqual({
					written: 2,
				});
			}
			// The five hundredth is a deletion, which counts as the files written do.
			expect(await store.deleteFile(`${REPO}/src/util.ts`)).toEqual({ deleted: true });
			expect(await store.writeFile(`${REPO}/many/one-more.txt`, "x\n")).toEqual({
				error: CHANGE_TOO_LARGE,
			});
			expect(await store.deleteFile(`${REPO}/src/index.ts`)).toEqual({ error: CHANGE_TOO_LARGE });
			// One of the five hundred can still be written again.
			expect(await store.writeFile(`${REPO}/many/file-0.txt`, "y\n")).toEqual({ written: 2 });
			expect(rowCounts(storage).changes).toBe(FILE_STORE_LIMITS.changedFiles);
		});

		await checkedOut(FILES, async ({ store }) => {
			const megabyte = "m".repeat(1_000_000);
			for (let index = 0; index < 20; index++) {
				expect(await store.writeFile(`${REPO}/bulk/${index}.txt`, megabyte)).toEqual({
					written: 1_000_000,
				});
			}
			expect(await store.writeFile(`${REPO}/bulk/last.txt`, "x")).toEqual({
				error: CHANGE_TOO_LARGE,
			});
		});
	});
});

describe("proposing the work", () => {
	it("commits what changed on the conversation's branch, with no git anywhere", async () => {
		await checkedOut(FILES, async ({ fake, store, asked }) => {
			await store.writeFile(`${REPO}/README.md`, "# Changed\n");
			await store.writeFile(`${REPO}/docs/new.md`, "new\n");
			const pushed = await store.push(BRANCH, "Change the readme", AUTHOR);
			expect(pushed).toEqual({ head: fake.branches.get(BRANCH), pushed: true });
			expect(asked.at(-1)).toEqual({ repository: "acme/site", access: "write" });
			expect(fake.filesAt(BRANCH)).toEqual({
				...FILES,
				"README.md": "# Changed\n",
				"docs/new.md": "new\n",
			});
			expect(fake.commitAt(BRANCH)).toMatchObject({
				message: "Change the readme",
				author: AUTHOR,
				parents: [fake.branches.get("main")],
			});
			// The default branch is where it was.
			expect(fake.filesAt("main")).toEqual(FILES);
		});
	});

	it("keeps a byte order mark, Windows line ends and the executable bit through an edit and a push", async () => {
		const script = "﻿#!/bin/sh\r\necho one\r\necho two\r\n";
		const files = { "bin/run.sh": script, "README.md": "# Site\n" };
		for (const dropsMark of [false, true]) {
			await checkedOut(
				files,
				async ({ fake, store }) => {
					fake.dropsMark = dropsMark;
					const call = calling(deletingFileTools(store, recorder().run));
					// A search first, so the file comes through GraphQL, as text, before it is edited.
					expect(await call("search", { pattern: "echo two" })).toBe(
						`${REPO}/bin/run.sh:3:echo two\r\n`,
					);
					expect(
						await call("edit_file", {
							path: "repo/bin/run.sh",
							old_text: "echo two",
							new_text: "echo 2",
						}),
					).toBe(`Replaced 1 place in ${REPO}/bin/run.sh.`);
					const pushed = await store.push(BRANCH, "Count in digits", AUTHOR);
					expect(pushed).toMatchObject({ pushed: true });

					const bytes = fake.bytesAt(BRANCH)["bin/run.sh"] ?? new Uint8Array();
					expect([...bytes]).toEqual([
						...new TextEncoder().encode("﻿#!/bin/sh\r\necho one\r\necho 2\r\n"),
					]);
					expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
					expect(fake.modesAt(BRANCH)["bin/run.sh"]).toBe("100755");
					expect(fake.modesAt(BRANCH)["README.md"]).toBe("100644");
				},
				{ executable: ["bin/run.sh"] },
			);
		}
	});

	it("takes a deleted file out, and leaves a symlink and a submodule as they were", async () => {
		await checkedOut(
			FILES,
			async ({ fake, store }) => {
				expect(await store.deleteFile(`${REPO}/docs/guide.md`)).toEqual({ deleted: true });
				expect(await store.readFile(`${REPO}/docs/guide.md`)).toEqual({
					error: `${REPO}/docs/guide.md does not exist.`,
				});
				expect(await store.deleteFile(`${REPO}/docs/guide.md`)).toEqual({
					error: `${REPO}/docs/guide.md does not exist.`,
				});
				// A file made here and deleted again was never a change.
				await store.writeFile(`${REPO}/docs/draft.md`, "draft\n");
				expect(await store.deleteFile(`${REPO}/docs/draft.md`)).toEqual({ deleted: true });
				// A submodule is a directory to a checkout: not listed, not read.
				expect(found(await store.findFiles("*", `${REPO}/vendor`))).toBe(`${REPO}/vendor/link\n`);
				expect(await store.readFile(`${REPO}/vendor/lib`)).toEqual({
					error: `${REPO}/vendor/lib is a submodule.`,
				});

				expect(await store.push(BRANCH, "Drop the guide", AUTHOR)).toMatchObject({ pushed: true });
				const { "docs/guide.md": _gone, ...rest } = FILES;
				expect(fake.filesAt(BRANCH)).toEqual({ ...rest, "vendor/link": "../README.md" });
				expect(fake.modesAt(BRANCH)).toMatchObject({
					"vendor/link": "120000",
					"vendor/lib": "160000",
				});
			},
			{
				symlinks: { "vendor/link": "../README.md" },
				submodules: { "vendor/lib": "a".repeat(40) },
			},
		);
	});

	it("goes on from its own commit on a second turn, and says when nothing is new", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			const first = await store.push(BRANCH, "One", AUTHOR);
			if ("error" in first) throw new Error(first.error);

			// Another turn: a new store over the same storage, which checks nothing out again.
			const later = storeOver(storage, fake).store;
			fake.requests.length = 0;
			expect(await later.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: false });
			expect(fake.requests).toEqual([]);
			expect(content(await later.readFile(`${REPO}/README.md`))).toBe("# One\n");
			await later.writeFile(`${REPO}/docs/guide.md`, "# Two\n");
			const second = await later.push(BRANCH, "Two", AUTHOR);
			if ("error" in second) throw new Error(second.error);
			expect(second.pushed).toBe(true);
			expect(fake.commitAt(BRANCH)).toMatchObject({ message: "Two", parents: [first.head] });
			expect(fake.filesAt(BRANCH)).toEqual({
				...FILES,
				"README.md": "# One\n",
				"docs/guide.md": "# Two\n",
			});

			// Nothing new since: the branch is where the conversation left it.
			expect(await later.push(BRANCH, "Three", AUTHOR)).toEqual({
				head: second.head,
				pushed: false,
			});
			expect(fake.branches.get(BRANCH)).toBe(second.head);
		});
	});

	it("puts nothing over a commit someone else made on the branch", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			expect(await store.push(BRANCH, "One", AUTHOR)).toMatchObject({ pushed: true });
			const theirs = await fake.push(BRANCH, "docs/theirs.md", "theirs\n");

			await store.writeFile(`${REPO}/README.md`, "# Two\n");
			expect(await store.push(BRANCH, "Two", AUTHOR)).toEqual({
				error: `The branch ${BRANCH} holds a commit this conversation did not make, so the work was not put over it.`,
			});
			expect(fake.branches.get(BRANCH)).toBe(theirs);
		});

		// A branch of that name someone made before the conversation's first push.
		await checkedOut(FILES, async ({ fake, store }) => {
			fake.branches.set(BRANCH, fake.branches.get("main") ?? "");
			const theirs = await fake.push(BRANCH, "docs/theirs.md", "theirs\n");
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			expect(await store.push(BRANCH, "One", AUTHOR)).toEqual({
				error: `The branch ${BRANCH} holds a commit this conversation did not make, so the work was not put over it.`,
			});
			expect(fake.branches.get(BRANCH)).toBe(theirs);
		});

		// A branch that is gone, as after its pull request merged.
		await checkedOut(FILES, async ({ fake, store }) => {
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			await store.push(BRANCH, "One", AUTHOR);
			fake.branches.delete(BRANCH);
			await store.writeFile(`${REPO}/README.md`, "# Two\n");
			const pushed = await store.push(BRANCH, "Two", AUTHOR);
			expect(pushed).toMatchObject({ error: expect.stringContaining("is gone from GitHub") });
			expect(fake.branches.has(BRANCH)).toBe(false);
		});
	});

	it("says there is nothing to propose, in a sandbox's words, without asking GitHub", async () => {
		await checkedOut(FILES, async ({ fake, store, asked }) => {
			const nothing = {
				error: "There is nothing to propose: the work has no commit that main does not.",
			};
			expect(await store.push(BRANCH, "Nothing", AUTHOR)).toEqual(nothing);
			// Written as it is, and written then put back: neither is a change.
			await store.writeFile(`${REPO}/README.md`, FILES["README.md"] ?? "");
			await store.writeFile(`${REPO}/src/util.ts`, "changed\n");
			await store.writeFile(`${REPO}/src/util.ts`, FILES["src/util.ts"] ?? "");
			expect(await store.push(BRANCH, "Nothing", AUTHOR)).toEqual(nothing);
			expect(fake.requests.filter((request) => !request.includes("/git/blobs/"))).toEqual([]);
			expect(asked.some((each) => each.access === "write")).toBe(false);
			expect(fake.branches.has(BRANCH)).toBe(false);
		});
	});

	it("refuses another branch than the conversation's, and a push before any checkout", async () => {
		await checkedOut(FILES, async ({ store }) => {
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			expect(await store.push("main", "One", AUTHOR)).toEqual({
				error: `This conversation works on ${BRANCH}, not main.`,
			});
		});
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		await inConversation(async (storage) => {
			const { store } = storeOver(storage, fake);
			expect(await store.push(BRANCH, "One", AUTHOR)).toEqual({
				error: "No repository is checked out here.",
			});
			expect(await store.findFiles("*", REPO)).toEqual({
				error: "No repository is checked out here.",
			});
		});
	});

	it("names the file a change cannot hold, where only the whole change shows it", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			await store.writeFile(`${REPO}/readme.md`, "a twin\n");
			expect(await store.push(BRANCH, "Twin", AUTHOR)).toEqual({
				error: `${REPO}/readme.md differs only in case from README.md, so nothing was proposed. Change that file, or delete it, and try again.`,
			});
			expect(fake.branches.has(BRANCH)).toBe(false);
			await store.deleteFile(`${REPO}/readme.md`);
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			expect(await store.push(BRANCH, "One", AUTHOR)).toMatchObject({ pushed: true });
		});
	});
});

describe("the token", () => {
	const WRONG = "ghs_a_token_github_does_not_know";

	it("that GitHub refuses is said in words, with no token and no request in them", async () => {
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		await inConversation(async (storage) => {
			const wrong = storeOver(storage, fake, { read: WRONG, write: WRONG }).store;
			const refused = await wrong.checkout(repositoryOf(fake), BRANCH);
			expect(refused).toEqual({
				error: "GitHub did not read acme/site (it answered 401). Try again.",
			});

			// Checked out with a good token, then read and pushed with a wrong one.
			await storeOver(storage, fake).store.checkout(repositoryOf(fake), BRANCH);
			const { run, ended } = recorder();
			const call = calling(deletingFileTools(wrong, run));
			const answers: string[] = [JSON.stringify(refused)];
			for (const [name, input] of [
				["read_file", { path: "repo/README.md" }],
				["search", { pattern: "needle" }],
				["write_file", { path: "repo/README.md", content: "x\n" }],
			] as const) {
				answers.push(String(await call(name, input).catch((error: unknown) => error)));
			}
			expect(answers[1]).toBe("Error: GitHub did not read acme/site (it answered 401). Try again.");
			expect(answers[2]).toBe("Error: GitHub did not read acme/site (it answered 401). Try again.");
			await wrong.writeFile(`${REPO}/docs/new.md`, "new\n");
			const pushed = await wrong.push(BRANCH, "New", AUTHOR);
			expect(pushed).toEqual({
				error: "GitHub did not write to acme/site (it answered 401). Try again.",
			});
			answers.push(JSON.stringify(pushed));

			// Nowhere: not in an answer, not in what the trace keeps, not in a row.
			for (const text of [...answers, JSON.stringify(ended), storedText(storage)]) {
				expect(text).not.toContain(WRONG);
				expect(text).not.toContain("ghs_");
				expect(text).not.toContain("Bearer");
				expect(text).not.toContain("api.github.com");
			}
		});
	});

	it("that may only read cannot push, and GitHub's own refusal carries no token", async () => {
		await checkedOut(FILES, async ({ fake, storage }) => {
			const reading = storeOver(storage, fake, { write: fake.readToken }).store;
			await reading.writeFile(`${REPO}/README.md`, "# One\n");
			expect(await reading.push(BRANCH, "One", AUTHOR)).toEqual({
				error:
					"The workspace's GitHub App may not write to acme/site. An owner or admin can give it the Contents permission, read and write.",
			});
			expect(fake.branches.has(BRANCH)).toBe(false);

			// A change GitHub refuses as invalid is given in GitHub's words, which name no token.
			const { store } = storeOver(storage, fake);
			const refused = await store.push(BRANCH, "One", {
				name: "Reviewer",
				email: "not an address",
			});
			expect(refused).toEqual({
				error: 'GitHub refused the change: GitHub answered 422: {"message":"Invalid author"}',
			});
			expect(JSON.stringify(refused)).not.toContain(fake.token);
			expect(storedText(storage)).not.toContain(fake.token);
			expect(storedText(storage)).not.toContain(fake.readToken);
		});
	});

	it("is asked for once a call, for the repository checked out, and never kept", async () => {
		await checkedOut(FILES, async ({ fake, store, storage, asked }) => {
			asked.length = 0;
			await store.readFile(`${REPO}/README.md`);
			await store.findFiles("*", REPO);
			await store.search({ pattern: "needle", path: REPO, ignoreCase: false });
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			await store.push(BRANCH, "One", AUTHOR);
			expect(asked).toEqual([
				{ repository: "acme/site", access: "read" },
				{ repository: "acme/site", access: "read" },
				{ repository: "acme/site", access: "write" },
			]);
			expect(storedText(storage)).not.toContain(fake.token);
			expect(storedText(storage)).not.toContain(fake.readToken);
		});
	});
});

describe("the tools over the store", () => {
	it("say their own rules where a sandbox's say ripgrep's, and nothing else differs", async () => {
		await checkedOut(FILES, async ({ store }) => {
			const tools = deletingFileTools(store, recorder().run);
			const sandbox = sandboxTools(new MemorySandbox(), recorder().run);
			expect(tools.find_files?.description).toBe(FILE_STORE_WORDS.findFiles);
			expect(tools.search?.description).toBe(FILE_STORE_WORDS.search);
			expect(sandbox.find_files?.description).toBe(SANDBOX_FILE_WORDS.findFiles);
			expect(sandbox.search?.description).toBe(SANDBOX_FILE_WORDS.search);
			for (const name of ["read_file", "write_file", "edit_file"]) {
				expect(tools[name]?.description).toBe(sandbox[name]?.description);
			}
			// A sandbox's turn has run_command to delete with, and is offered no tool for it.
			expect(Object.keys(sandbox)).not.toContain("delete_file");
		});
	});
});
