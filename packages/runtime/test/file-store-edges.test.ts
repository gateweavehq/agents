import { createCommit, GitHubError } from "@gateweave/agents-github";
import { FakeGit } from "@gateweave/agents-github/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_STORE_LIMITS, FileStore } from "../src/file-store";
import { GLOB_LIMITS } from "../src/glob";
import {
	AUTHOR,
	BRANCH,
	inConversation,
	repositoryOf,
	rowCounts,
	storedText,
	storeOver,
	useGitHub,
} from "./file-store-support";

// The files store where it could go wrong quietly: values too large to back up, bytes it cannot
// read back, a push whose note was lost, GitHub's refusals told as what they are not, and calls
// that run side by side. Against the stand-in for GitHub; no request reaches the real one.

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const REPO = "/workspace/repo";
const NUL = String.fromCharCode(0);

const FILES: Record<string, string> = {
	"README.md": "# Site\n\nA needle in the readme.\n",
	"docs/guide.md": "# Guide\n\nSecond needle line.\n",
	"src/index.ts": "export const needle = 1;\n",
};

type At = {
	fake: FakeGit;
	store: FileStore;
	storage: DurableObjectStorage;
};

async function checkedOut(
	files: Record<string, string | Uint8Array>,
	body: (at: At) => Promise<void>,
): Promise<void> {
	const fake = new FakeGit();
	await fake.seed(files);
	useGitHub(fake);
	await inConversation(async (storage) => {
		const { store } = storeOver(storage, fake);
		expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: true });
		fake.requests.length = 0;
		await body({ fake, store, storage });
	});
}

/** GitHub is the fake, but for the requests `instead` answers itself. */
function answering(fake: FakeGit, instead: (route: string) => Response | undefined): void {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const answer = instead(`${request.method} ${new URL(request.url).pathname}`);
		return answer ?? fake.fetch(request);
	});
}

function refusing(status: number, message: string): Response {
	return Response.json({ message }, { status });
}

const LIMITED =
	"GitHub is limiting the requests of the workspace's GitHub App just now. Wait a few minutes before trying again.";

describe("what one row holds", () => {
	it("is at most 900,000 bytes, so that quote() of it stays under 2 MB", async () => {
		// The arithmetic the limit rests on: two characters a byte and X'' around them.
		expect(FILE_STORE_LIMITS.storedBytes * 2 + 3).toBeLessThan(2_000_000);
		expect(FILE_STORE_LIMITS.writtenBytes).toBeLessThanOrEqual(FILE_STORE_LIMITS.storedBytes);
		expect(FILE_STORE_LIMITS.readBytes).toBeLessThanOrEqual(FILE_STORE_LIMITS.storedBytes);

		// The largest file that is read, and the largest that is written.
		const files = { ...FILES, "largest.txt": "r".repeat(FILE_STORE_LIMITS.readBytes) };
		await checkedOut(files, async ({ store, storage }) => {
			expect(await store.readFile(`${REPO}/largest.txt`)).toMatchObject({
				content: expect.stringMatching(/^r+$/),
			});
			const most = "w".repeat(FILE_STORE_LIMITS.writtenBytes);
			expect(await store.writeFile(`${REPO}/written.txt`, most)).toEqual({ written: 900_000 });
			expect(await store.writeFile(`${REPO}/over.txt`, `${most}w`)).toEqual({
				error: `${REPO}/over.txt would be 900001 bytes, over what one file can hold here (900000).`,
			});
			const quoted = (table: string) =>
				storage.sql
					.exec<{ longest: number }>(`SELECT max(length(quote(bytes))) AS longest FROM ${table}`)
					.one().longest;
			expect(quoted("file_blobs")).toBe(FILE_STORE_LIMITS.readBytes * 2 + 3);
			expect(quoted("file_changes")).toBe(1_800_003);
			for (const table of ["file_listing", "file_blobs", "file_changes"]) {
				expect(quoted(table)).toBeLessThan(2_000_000);
			}
		});
	});

	it("answers a blob too large for one value, and asks again rather than keep it", async () => {
		const stored = FILE_STORE_LIMITS.storedBytes;
		FILE_STORE_LIMITS.storedBytes = 20;
		try {
			await checkedOut(FILES, async ({ fake, store, storage }) => {
				expect(await store.readFile(`${REPO}/README.md`)).toEqual({ content: FILES["README.md"] });
				expect(
					storage.sql.exec("SELECT kind, bytes IS NULL AS empty FROM file_blobs").toArray(),
				).toEqual([{ kind: "unread", empty: 1 }]);
				expect(await store.readFile(`${REPO}/README.md`)).toEqual({ content: FILES["README.md"] });
				expect(fake.requests).toHaveLength(2);
			});
		} finally {
			FILE_STORE_LIMITS.storedBytes = stored;
		}
	});
});

describe("bytes that are not text", () => {
	it("are not written: a NUL makes a file binary, and is refused with why", async () => {
		await checkedOut(FILES, async ({ store, storage }) => {
			expect(await store.writeFile(`${REPO}/README.md`, `# Si${NUL}te\n`)).toEqual({
				error: `${REPO}/README.md would hold a NUL character, which makes a file binary to git and to a search. Text files hold none.`,
			});
			expect(await store.writeFile(`${REPO}/new.md`, `${NUL}`)).toMatchObject({
				error: expect.stringContaining("NUL character"),
			});
			expect(rowCounts(storage).changes).toBe(0);
			expect(await store.readFile(`${REPO}/README.md`)).toEqual({ content: FILES["README.md"] });
		});
	});

	it("are never answered as an empty file, nor committed as one, should a row hold them", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			// No write lets such a row in; this one is put there by hand, as a fault would.
			const bytes = new TextEncoder().encode(`# Si${NUL}te\n`);
			storage.sql.exec(
				"INSERT INTO file_changes (path, original, bytes, size, changed_at) VALUES (?, NULL, ?, ?, 1)",
				"README.md",
				bytes.buffer,
				bytes.length,
			);
			const unread = `${REPO}/README.md holds bytes that are not text, so it cannot be read here.`;
			expect(await store.readFile(`${REPO}/README.md`)).toEqual({ error: unread });
			expect(
				await store.search({ pattern: "Si", path: `${REPO}/README.md`, ignoreCase: false }),
			).toEqual({ error: unread });
			expect(await store.search({ pattern: "Si", path: REPO, ignoreCase: false })).toEqual({
				error: unread,
			});
			expect(await store.push(BRANCH, "Broken", AUTHOR)).toEqual({
				error: `${unread} Nothing was proposed. Write the file again, or delete it.`,
			});
			expect(fake.branches.has(BRANCH)).toBe(false);
			expect(fake.requests.filter((request) => !request.startsWith("GET"))).toEqual([
				"POST /graphql",
			]);
		});
	});
});

describe("a commit GitHub took and the conversation has no note of", () => {
	const forget = (storage: DurableObjectStorage, tip: string | null) =>
		storage.sql.exec("UPDATE file_checkout SET tip = ? WHERE id = 1", tip);
	const noted = (storage: DurableObjectStorage) =>
		storage.sql.exec<{ tip: string | null }>("SELECT tip FROM file_checkout").one().tip;

	it("is taken for its own when the push is the same, and nothing is committed twice", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			await store.deleteFile(`${REPO}/docs/guide.md`);
			const first = await store.push(BRANCH, "One", AUTHOR);
			if ("error" in first) throw new Error(first.error);
			forget(storage, null);

			expect(await store.push(BRANCH, "One", AUTHOR)).toEqual({ head: first.head, pushed: false });
			expect(fake.branches.get(BRANCH)).toBe(first.head);
			expect(noted(storage)).toBe(first.head);
		});
	});

	it("is taken for its own and built on, when the work has gone on since", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			const first = await store.push(BRANCH, "One", AUTHOR);
			if ("error" in first) throw new Error(first.error);
			forget(storage, null);

			await store.writeFile(`${REPO}/docs/new.md`, "new\n");
			const second = await store.push(BRANCH, "Two", AUTHOR);
			if ("error" in second) throw new Error(second.error);
			expect(second.pushed).toBe(true);
			expect(fake.commitAt(BRANCH)).toMatchObject({ message: "Two", parents: [first.head] });
			expect(fake.filesAt(BRANCH)).toEqual({
				...FILES,
				"README.md": "# One\n",
				"docs/new.md": "new\n",
			});

			// The same for a later push whose note fell back to the one before it.
			forget(storage, first.head);
			await store.deleteFile(`${REPO}/src/index.ts`);
			const third = await store.push(BRANCH, "Three", AUTHOR);
			if ("error" in third) throw new Error(third.error);
			expect(fake.commitAt(BRANCH)).toMatchObject({ message: "Three", parents: [second.head] });
			expect(noted(storage)).toBe(third.head);
		});
	});

	it("is someone else's when it holds what this push would not put there", async () => {
		const theirs = (branch: string) =>
			`The branch ${branch} holds a commit this conversation did not make, so the work was not put over it.`;
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			const first = await store.push(BRANCH, "One", AUTHOR);
			if ("error" in first) throw new Error(first.error);
			forget(storage, null);
			// The conversation changed the file again: the commit no longer holds its work.
			await store.writeFile(`${REPO}/README.md`, "# Two\n");
			expect(await store.push(BRANCH, "Two", AUTHOR)).toEqual({ error: theirs(BRANCH) });
			expect(fake.branches.get(BRANCH)).toBe(first.head);
			expect(noted(storage)).toBeNull();
		});

		await checkedOut(FILES, async ({ fake, store, storage }) => {
			// Two commits ahead of the note: only one directly on it is looked at.
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			await store.push(BRANCH, "One", AUTHOR);
			await store.writeFile(`${REPO}/docs/new.md`, "new\n");
			const second = await store.push(BRANCH, "Two", AUTHOR);
			if ("error" in second) throw new Error(second.error);
			forget(storage, null);
			expect(await store.push(BRANCH, "Two", AUTHOR)).toEqual({ error: theirs(BRANCH) });
			expect(fake.branches.get(BRANCH)).toBe(second.head);
		});

		await checkedOut(FILES, async ({ fake, store }) => {
			// The other way round: a commit someone else did make, from the base, that holds
			// README as this push writes it and everything else as the base has it. Nothing in it
			// is anything this push would not put there, so it is built on, and nothing of theirs
			// is dropped: who made it does not matter.
			fake.branches.set(BRANCH, fake.branches.get("main") ?? "");
			const made = await fake.push(BRANCH, "README.md", "# One\n");
			await store.writeFile(`${REPO}/README.md`, "# One\n");
			await store.writeFile(`${REPO}/docs/guide.md`, "# Other\n");
			const pushed = await store.push(BRANCH, "Mine", AUTHOR);
			expect(fake.commitAt(BRANCH)?.parents).toEqual([made]);
			expect(pushed).toMatchObject({ pushed: true });
			expect(fake.filesAt(BRANCH)).toEqual({
				...FILES,
				"README.md": "# One\n",
				"docs/guide.md": "# Other\n",
			});
		});
	});

	const theirs = `The branch ${BRANCH} holds a commit this conversation did not make, so the work was not put over it.`;

	/** A commit on the branch's tip, by someone else, that takes one file away. */
	async function removed(fake: FakeGit, path: string): Promise<string> {
		const parent = fake.branches.get(BRANCH) ?? fake.branches.get("main") ?? "";
		const commit = await createCommit(fake.token, fake.repository, {
			parent,
			tree: fake.commits.get(parent)?.tree ?? "",
			files: [],
			deleted: [path],
			message: `someone removed ${path}`,
		});
		fake.branches.set(BRANCH, commit);
		return commit;
	}

	it("is someone else's when it puts back a file the conversation changed", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			await store.writeFile(`${REPO}/README.md`, "# Mine\n");
			const first = await store.push(BRANCH, "Mine", AUTHOR);
			if ("error" in first) throw new Error(first.error);
			// Someone reverts it on the branch: the file is the base's again, which is not what
			// the conversation's commit before it held, and not what this push would leave.
			const reverted = await fake.push(BRANCH, "README.md", FILES["README.md"] ?? "");

			expect(await store.push(BRANCH, "Mine again", AUTHOR)).toEqual({ error: theirs });
			await store.writeFile(`${REPO}/docs/new.md`, "new\n");
			expect(await store.push(BRANCH, "And more", AUTHOR)).toEqual({ error: theirs });
			expect(fake.branches.get(BRANCH)).toBe(reverted);
			expect(fake.filesAt(BRANCH)).toEqual(FILES);
			expect(noted(storage)).toBe(first.head);
		});
	});

	it("is someone else's when it restores a file the conversation deleted", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			await store.deleteFile(`${REPO}/docs/guide.md`);
			expect(await store.push(BRANCH, "Drop the guide", AUTHOR)).toMatchObject({ pushed: true });
			const restored = await fake.push(BRANCH, "docs/guide.md", FILES["docs/guide.md"] ?? "");

			await store.writeFile(`${REPO}/docs/new.md`, "new\n");
			expect(await store.push(BRANCH, "And more", AUTHOR)).toEqual({ error: theirs });
			expect(fake.branches.get(BRANCH)).toBe(restored);
			expect(fake.filesAt(BRANCH)).toEqual(FILES);
		});
	});

	it("is someone else's when it removes a file the conversation added", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			await store.writeFile(`${REPO}/docs/new.md`, "new\n");
			expect(await store.push(BRANCH, "Add a page", AUTHOR)).toMatchObject({ pushed: true });
			const taken = await removed(fake, "docs/new.md");

			await store.writeFile(`${REPO}/README.md`, "# Mine\n");
			expect(await store.push(BRANCH, "And more", AUTHOR)).toEqual({ error: theirs });
			expect(fake.branches.get(BRANCH)).toBe(taken);
			expect(fake.filesAt(BRANCH)).toEqual(FILES);
		});
	});

	it("is someone else's when it changes only whether a file can be run", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			// The same text, made executable: a change the push would undo by leaving the base's mode.
			const parent = fake.branches.get("main") ?? "";
			const made = await createCommit(fake.token, fake.repository, {
				parent,
				tree: fake.commits.get(parent)?.tree ?? "",
				files: [{ path: "README.md", content: FILES["README.md"] ?? "", mode: "100755" }],
				message: "someone made the readme executable",
			});
			fake.branches.set(BRANCH, made);

			await store.writeFile(`${REPO}/docs/new.md`, "new\n");
			expect(await store.push(BRANCH, "Mine", AUTHOR)).toEqual({ error: theirs });
			expect(fake.branches.get(BRANCH)).toBe(made);
			expect(fake.modesAt(BRANCH)["README.md"]).toBe("100755");
		});
	});

	it("is someone else's when it lacks a file this push does not delete, and its own when it does", async () => {
		// Before any push the commit is held against the base.
		await checkedOut(FILES, async ({ fake, store }) => {
			const taken = await removed(fake, "src/index.ts");
			await store.writeFile(`${REPO}/README.md`, "# Mine\n");
			expect(await store.push(BRANCH, "Mine", AUTHOR)).toEqual({ error: theirs });
			expect(fake.branches.get(BRANCH)).toBe(taken);

			// Once the push deletes that file too, the commit holds nothing the push would undo.
			await store.deleteFile(`${REPO}/src/index.ts`);
			expect(await store.push(BRANCH, "Mine", AUTHOR)).toMatchObject({ pushed: true });
			expect(fake.commitAt(BRANCH)?.parents).toEqual([taken]);
			const { "src/index.ts": _gone, ...rest } = FILES;
			expect(fake.filesAt(BRANCH)).toEqual({ ...rest, "README.md": "# Mine\n" });
		});
	});
});

describe("a name that changes only in case", () => {
	it("is refused while the other stands, and taken once the conversation deleted it", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			expect(await store.writeFile(`${REPO}/Readme.md`, "# Renamed\n")).toMatchObject({
				error: expect.stringContaining(`differs only in case from ${REPO}/README.md`),
			});
			expect(await store.deleteFile(`${REPO}/README.md`)).toEqual({ deleted: true });
			expect(await store.writeFile(`${REPO}/Readme.md`, "# Renamed\n")).toEqual({ written: 10 });
			// A directory is gone once its files are, and can come back in another case.
			expect(await store.writeFile(`${REPO}/Docs/guide.md`, "# Guide\n")).toMatchObject({
				error: expect.stringContaining(`differs only in case from ${REPO}/docs`),
			});
			expect(await store.deleteFile(`${REPO}/docs/guide.md`)).toEqual({ deleted: true });
			expect(await store.writeFile(`${REPO}/Docs/guide.md`, "# Guide\n")).toEqual({ written: 8 });
			// The new names are there to differ from now, and the old ones are not.
			expect(await store.writeFile(`${REPO}/README.md`, "# Back\n")).toMatchObject({
				error: expect.stringContaining(`differs only in case from ${REPO}/Readme.md`),
			});

			expect(await store.push(BRANCH, "Rename", AUTHOR)).toMatchObject({ pushed: true });
			expect(fake.filesAt(BRANCH)).toEqual({
				"Readme.md": "# Renamed\n",
				"Docs/guide.md": "# Guide\n",
				"src/index.ts": FILES["src/index.ts"],
			});
		});
	});
});

describe("what GitHub refuses, told as what it is", () => {
	it("a 403 that is a rate limit is a limit, not a missing permission", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			answering(fake, (route) =>
				route.includes("/git/blobs/")
					? refusing(403, "API rate limit exceeded for installation ID 77.")
					: route === "POST /repos/acme/site/git/trees"
						? refusing(403, "You have exceeded a secondary rate limit. Please wait a few minutes.")
						: undefined,
			);
			expect(await store.readFile(`${REPO}/README.md`)).toEqual({ error: LIMITED });
			await store.writeFile(`${REPO}/new.md`, "new\n");
			expect(await store.push(BRANCH, "New", AUTHOR)).toEqual({ error: LIMITED });

			// A 403 that names no limit is the permission it says it is.
			answering(fake, (route) =>
				route.includes("/git/blobs/")
					? refusing(403, "Resource not accessible by integration")
					: undefined,
			);
			expect(await store.readFile(`${REPO}/README.md`)).toEqual({
				error:
					"The workspace's GitHub App may not read acme/site. An owner or admin can give it the Contents permission.",
			});
		});
	});

	it("a GraphQL answer with no repository is a limit or a missing repository, by its errors", async () => {
		await checkedOut(FILES, async ({ fake, store }) => {
			const search = () => store.search({ pattern: "needle", path: REPO, ignoreCase: false });
			answering(fake, (route) =>
				route === "POST /graphql"
					? Response.json({
							errors: [
								{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation." },
							],
						})
					: undefined,
			);
			expect(await search()).toEqual({ error: LIMITED });
			answering(fake, (route) =>
				route === "POST /graphql"
					? Response.json({
							data: { repository: null },
							errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository." }],
						})
					: undefined,
			);
			expect(await search()).toEqual({
				error: "The workspace's GitHub App no longer reaches acme/site.",
			});
			answering(fake, (route) =>
				route === "POST /graphql" ? refusing(502, "Bad gateway") : undefined,
			);
			expect(await search()).toEqual({
				error: "GitHub could not answer just now (502). Try again.",
			});
		});
	});

	it("no token for the push is not a change GitHub refused", async () => {
		await checkedOut(FILES, async ({ fake, storage }) => {
			const store = new FileStore(storage, async (_repository, access) => {
				if (access === "read") return fake.readToken;
				throw new GitHubError(
					422,
					'GitHub answered 422: {"message":"The permissions requested are not granted to this installation."}',
				);
			});
			await store.writeFile(`${REPO}/new.md`, "new\n");
			const pushed = await store.push(BRANCH, "New", AUTHOR);
			expect(pushed).toEqual({
				error:
					"GitHub gave the workspace's GitHub App no access to write to acme/site: the app does not hold the Contents permission, read and write, or no longer reaches the repository. An owner or admin can check its permissions.",
			});
			expect(JSON.stringify(pushed)).not.toContain("refused the change");
			// Nothing was asked of GitHub's Git database for it.
			expect(fake.requests.filter((request) => !request.includes("/git/blobs/"))).toEqual([]);

			const reading = new FileStore(storage, async () => {
				throw new GitHubError(404, 'GitHub answered 404: {"message":"Not Found"}');
			});
			expect(await reading.readFile(`${REPO}/docs/guide.md`)).toEqual({
				error:
					"The workspace's GitHub App is not installed where it reaches acme/site, or was suspended there. An owner or admin can check the app's installation.",
			});
		});
	});

	it("GitHub's own words for a change it refuses come without the token, were it ever in them", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			answering(fake, (route) =>
				route === "POST /repos/acme/site/git/commits"
					? refusing(422, `Bearer ${fake.token} may not name that author`)
					: undefined,
			);
			await store.writeFile(`${REPO}/new.md`, "new\n");
			const pushed = await store.push(BRANCH, "New", AUTHOR);
			expect(pushed).toEqual({
				error:
					'GitHub refused the change: GitHub answered 422: {"message":"Bearer [token] may not name that author"}',
			});
			expect(JSON.stringify(pushed)).not.toContain(fake.token);
			expect(storedText(storage)).not.toContain(fake.token);
		});
	});
});

describe("calls that run side by side", () => {
	it("check a repository out once, though two asked GitHub at the same time", async () => {
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		await inConversation(async (storage) => {
			// Two stores, as two turns' would be: neither knows of the other's checkout under way.
			const one = storeOver(storage, fake).store;
			const other = storeOver(storage, fake).store;
			const results = await Promise.all([
				one.checkout(repositoryOf(fake), BRANCH),
				other.checkout(repositoryOf(fake), BRANCH),
			]);
			const made = results.map((result) => "checkedOut" in result && result.checkedOut);
			expect(made.sort()).toEqual([false, true]);
			// Both asked, and the second found the first's rows when it came to write.
			expect(fake.requests).toHaveLength(4);
			expect(rowCounts(storage)).toEqual({ checkout: 1, listing: 1, blobs: 0, changes: 0 });
			expect(await other.readFile(`${REPO}/README.md`)).toEqual({ content: FILES["README.md"] });
		});
	});

	it("never make room by taking a file the search under way is to read", async () => {
		const files = {
			"d/a.txt": `needle ${"a".repeat(53)}`,
			"d/b.txt": `needle ${"b".repeat(53)}`,
			"d/c.txt": `needle ${"c".repeat(53)}`,
			"x.txt": "x".repeat(60),
		};
		const held = FILE_STORE_LIMITS.heldBytes;
		FILE_STORE_LIMITS.heldBytes = 200;
		try {
			await checkedOut(files, async ({ fake, store }) => {
				// The oldest file held is one the search will want; the next oldest is not.
				await store.readFile(`${REPO}/d/a.txt`);
				await store.readFile(`${REPO}/x.txt`);
				const found = await store.search({
					pattern: "needle",
					path: `${REPO}/d`,
					ignoreCase: false,
				});
				expect(found).toEqual({
					found: ["a", "b", "c"]
						.map((name) => `${REPO}/d/${name}.txt:1:needle ${name.repeat(53)}\n`)
						.join(""),
				});
				// Room was made by the file outside the search, which is asked for again.
				const asked = fake.requests.length;
				await store.readFile(`${REPO}/d/a.txt`);
				expect(fake.requests).toHaveLength(asked);
				await store.readFile(`${REPO}/x.txt`);
				expect(fake.requests).toHaveLength(asked + 1);
			});
		} finally {
			FILE_STORE_LIMITS.heldBytes = held;
		}
	});

	it("stop a search with why, when another call took a file it was to read", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 60; index++) {
			files[`many/file-${String(index).padStart(2, "0")}.txt`] = `needle ${index}\n`;
		}
		await checkedOut(files, async ({ fake, store, storage }) => {
			// Sixty files are two requests. While the second is under way, a row the first brought
			// goes, as it would when another call made room.
			let requests = 0;
			let taken = "";
			fake.before = (route) => {
				if (route !== "POST /graphql" || ++requests !== 2) return;
				const [row] = storage.sql
					.exec<{ id: string }>("SELECT id FROM file_blobs ORDER BY id LIMIT 1")
					.toArray();
				taken = row?.id ?? "";
				storage.sql.exec("DELETE FROM file_blobs WHERE id = ?", taken);
			};
			const search = () => store.search({ pattern: "needle", path: REPO, ignoreCase: false });
			const stopped = await search();
			expect(taken).not.toBe("");
			expect(stopped).toEqual({
				error: expect.stringMatching(
					/^\/workspace\/repo\/many\/file-\d\d\.txt is not held to be searched, as it was to be when this search began: another call changed the files or made room for others meanwhile\. Search again\.$/,
				),
			});

			// Again, it asks for the one file it lacks and answers with every line.
			fake.before = undefined;
			const again = await search();
			if ("error" in again) throw new Error(again.error);
			expect(again.found?.split("\n").filter((line) => line !== "")).toHaveLength(60);
		});
	});

	it("search the base's file when another call put an edited file back while the search waited", async () => {
		const files = { "a.txt": "needle as it was\n", "b.txt": "needle b\n", "c.txt": "nothing\n" };
		await checkedOut(files, async ({ fake, store }) => {
			await store.readFile(`${REPO}/a.txt`);
			await store.writeFile(`${REPO}/a.txt`, "needle as edited\n");
			// The search lists a.txt as written, then asks GitHub for the other two. Meanwhile
			// another call writes a.txt back as the base has it, which takes its change away.
			fake.before = async (route) => {
				if (route !== "POST /graphql") return;
				fake.before = undefined;
				expect(await store.writeFile(`${REPO}/a.txt`, files["a.txt"])).toEqual({ written: 17 });
			};
			expect(await store.search({ pattern: "needle", path: REPO, ignoreCase: false })).toEqual({
				found: `${REPO}/a.txt:1:needle as it was\n${REPO}/b.txt:1:needle b\n`,
			});
		});
	});

	it("search a file as it is when the answer is made, deleted or edited while the search waited", async () => {
		const files = {
			"a.txt": "needle to be deleted\n",
			"b.txt": "needle b\n",
			"c.txt": "needle to be edited\n",
		};
		await checkedOut(files, async ({ fake, store }) => {
			// Two files are held and unchanged when the search lists them; it asks GitHub for the
			// third, and meanwhile other calls delete one of the two and edit the other.
			await store.readFile(`${REPO}/a.txt`);
			await store.readFile(`${REPO}/c.txt`);
			fake.before = async (route) => {
				if (route !== "POST /graphql") return;
				fake.before = undefined;
				expect(await store.deleteFile(`${REPO}/a.txt`)).toEqual({ deleted: true });
				expect(await store.writeFile(`${REPO}/c.txt`, "needle as edited\n")).toEqual({
					written: 17,
				});
			};
			expect(await store.search({ pattern: "needle", path: REPO, ignoreCase: false })).toEqual({
				found: `${REPO}/b.txt:1:needle b\n${REPO}/c.txt:1:needle as edited\n`,
			});
		});
	});

	it("answer each caller of a checkout for the repository it asked for", async () => {
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		await inConversation(async (storage) => {
			const { store } = storeOver(storage, fake);
			const site = repositoryOf(fake);
			const other = { ...site, name: "other", externalId: "9" };
			// Three calls on one store while the first is still asking GitHub.
			const results = await Promise.all([
				store.checkout(site, BRANCH),
				store.checkout(other, BRANCH),
				store.checkout(site, BRANCH),
			]);
			expect(results).toEqual([
				{ checkedOut: true },
				{
					error:
						"This conversation has acme/site checked out. Start a new conversation to work on acme/other.",
				},
				{ checkedOut: false },
			]);
			// GitHub was asked once, for the first.
			expect(fake.requests).toHaveLength(2);
			expect(rowCounts(storage).checkout).toBe(1);
		});

		// Two stores, where the other's checkout is found only in the write: the same answer.
		const again = new FakeGit();
		await again.seed(FILES);
		useGitHub(again);
		await inConversation(async (storage) => {
			const site = repositoryOf(again);
			const other = { ...site, externalId: "9" };
			const results = await Promise.all([
				storeOver(storage, again).store.checkout(site, BRANCH),
				storeOver(storage, again).store.checkout(other, BRANCH),
			]);
			expect(results).toEqual([
				{ checkedOut: true },
				{
					error:
						"This conversation has acme/site checked out. Start a new conversation to work on acme/site.",
				},
			]);
		});
	});

	it("keep one of two files that cannot both be there, written at the same time", async () => {
		await checkedOut(FILES, async ({ fake, store, storage }) => {
			// README.md is deleted, so its name is free in any case. Writing it again has to hash
			// its bytes first, and meanwhile another call writes the name in another case.
			await store.deleteFile(`${REPO}/README.md`);
			const [upper, lower] = await Promise.all([
				store.writeFile(`${REPO}/README.md`, "# Back\n"),
				store.writeFile(`${REPO}/Readme.md`, "# Renamed\n"),
			]);
			expect(lower).toEqual({ written: 10 });
			expect(upper).toEqual({
				error: `${REPO}/README.md differs only in case from ${REPO}/Readme.md, which is there already. On Windows and macOS the two would be one.`,
			});
			// A file and a file under it, the same way.
			const [file, under] = await Promise.all([
				store.writeFile(`${REPO}/new`, "a file\n"),
				store.writeFile(`${REPO}/new/page.md`, "a page\n"),
			]);
			expect([file, under]).toEqual([
				{ written: 7 },
				{ error: `A part of ${REPO}/new/page.md is a file, not a directory.` },
			]);
			expect(rowCounts(storage).changes).toBe(3);
			// What was kept can be proposed.
			expect(await store.push(BRANCH, "Rename", AUTHOR)).toMatchObject({ pushed: true });
			expect(Object.keys(fake.filesAt(BRANCH)).sort()).toEqual(
				["Readme.md", "docs/guide.md", "new", "src/index.ts"].sort(),
			);
		});
	});
});

describe("a glob that would take too long", () => {
	it("is stopped, and the tool answers in words", async () => {
		const steps = GLOB_LIMITS.steps;
		GLOB_LIMITS.steps = 10;
		try {
			await checkedOut(FILES, async ({ store }) => {
				const slow = {
					error: "That glob takes too long to match against these files. Use a simpler one.",
				};
				expect(await store.findFiles("**/*.md", REPO)).toEqual(slow);
				expect(
					await store.search({ pattern: "needle", path: REPO, glob: "**/*.md", ignoreCase: false }),
				).toEqual(slow);
			});
		} finally {
			GLOB_LIMITS.steps = steps;
		}
		await checkedOut(FILES, async ({ store }) => {
			expect(await store.findFiles("**/*.md", REPO)).toEqual({
				found: `${REPO}/README.md\n${REPO}/docs/guide.md\n`,
			});
			expect(await store.findFiles(`${"*/".repeat(70)}x`, REPO)).toEqual({
				error: "That glob has more than 64 parts between its slashes.",
			});
		});
	});
});
