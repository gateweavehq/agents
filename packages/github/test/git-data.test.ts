// Reading and writing a repository with no git: modes, a blob's exact bytes, a commit with
// deletions and the branch it goes on. GitHub is `FakeGit`, whose file says what it refuses and
// what about GitHub nobody has tried; nothing here reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	branchCommit,
	branchHead,
	type ChangesInput,
	commitChanges,
	createBranch,
	createCommit,
	GitHubError,
	gitBlobId,
	moveBranch,
	readBlob,
	readTree,
	readTreeEntries,
	repositoryPathProblem,
} from "../src";
import { FakeGit } from "./fake-git";

const PINNED = "f".repeat(40);
const SCRIPT = "#!/bin/sh\npnpm build\n";
const SEED = {
	"README.md": "# Site\n",
	"docs/guide.md": "Old guide.\n",
	"docs/old.md": "To be deleted.\n",
	"scripts/build.sh": SCRIPT,
	"scripts/run.sh": "#!/bin/sh\nexec node .\n",
};

let github: FakeGit;
let head: { commit: string; tree: string };

beforeEach(async () => {
	github = new FakeGit();
	const commit = await github.seed(SEED, {
		executable: ["scripts/build.sh", "scripts/run.sh"],
		symlinks: { "CLAUDE.md": "AGENTS.md" },
		submodules: { "vendor/lib": PINNED },
	});
	head = { commit, tree: github.commits.get(commit)?.tree ?? "" };
	vi.stubGlobal("fetch", github.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A change as a conversation would send its first: the branch is new, the base is the head. */
async function change(input: Partial<ChangesInput> = {}): Promise<ChangesInput> {
	const listing = await readTreeEntries(github.token, github.repository, head.tree);
	return {
		branch: "gateweave/c-1",
		defaultBranch: github.defaultBranch,
		expected: null,
		base: { ...head, ...listing },
		files: [],
		deleted: [],
		message: "Change the guide",
		...input,
	};
}

describe("a tree's entries", () => {
	it("come back with their modes: a file, an executable, a symlink and a submodule", async () => {
		const listing = await readTreeEntries(github.token, github.repository, head.tree);

		expect(listing.truncated).toBe(false);
		expect(Object.fromEntries(listing.entries.map((entry) => [entry.path, entry.mode]))).toEqual({
			"CLAUDE.md": "120000",
			"README.md": "100644",
			"docs/guide.md": "100644",
			"docs/old.md": "100644",
			"scripts/build.sh": "100755",
			"scripts/run.sh": "100755",
			"vendor/lib": "160000",
		});
		const byPath = new Map(listing.entries.map((entry) => [entry.path, entry]));
		expect(byPath.get("scripts/build.sh")).toEqual({
			path: "scripts/build.sh",
			mode: "100755",
			id: await gitBlobId(new TextEncoder().encode(SCRIPT)),
			size: SCRIPT.length,
		});
		// A submodule's id is the commit it pins, and it has no size.
		expect(byPath.get("vendor/lib")).toEqual({
			path: "vendor/lib",
			mode: "160000",
			id: PINNED,
			size: 0,
		});
	});

	it("are the same files `readTree` lists, which still leaves out modes and submodules", async () => {
		const { files, truncated } = await readTree(github.token, github.repository, head.tree);

		expect(truncated).toBe(false);
		expect(files.map((file) => file.path)).toEqual([
			"CLAUDE.md",
			"README.md",
			"docs/guide.md",
			"docs/old.md",
			"scripts/build.sh",
			"scripts/run.sh",
		]);
		expect(files[0]).toEqual({
			path: "CLAUDE.md",
			blob: await gitBlobId(new TextEncoder().encode("AGENTS.md")),
			size: 9,
			symlink: true,
		});
		expect(Object.keys(files[4] ?? {})).toEqual(["path", "blob", "size", "symlink"]);
	});

	it("say when GitHub cut the listing short", async () => {
		github.listingLimit = 4;

		const listing = await readTreeEntries(github.token, github.repository, head.tree);
		expect(listing.truncated).toBe(true);
		expect(listing.entries.length).toBeLessThan(7);
		expect((await readTree(github.token, github.repository, head.tree)).truncated).toBe(true);
	});
});

describe("a blob's bytes", () => {
	it("are exact: a byte order mark, Windows line ends and text that is not ASCII", async () => {
		const text = "\uFEFFİlk satır\r\nZweite Zeile: größer\r\n終わり\r\n";
		const bytes = new TextEncoder().encode(text);
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		await github.seed({ "notes.txt": text });
		const id = await gitBlobId(bytes);

		const read = await readBlob(github.token, github.repository, id, 1024);

		expect(read).toEqual({ read: true, bytes, size: bytes.length });
		expect(github.requests.at(-1)).toBe(`GET /repos/acme/site/git/blobs/${id}`);
	});

	it("are exact for bytes that are not text at all, and for none", async () => {
		const bytes = Uint8Array.from({ length: 700 }, (_, index) => (index * 7) % 256);
		await github.seed({ "logo.bin": bytes, empty: new Uint8Array() });

		const read = await readBlob(github.token, github.repository, await gitBlobId(bytes), 700);
		expect(read).toEqual({ read: true, bytes, size: 700 });

		const none = await gitBlobId(new Uint8Array());
		expect(await readBlob(github.token, github.repository, none, 0)).toEqual({
			read: true,
			bytes: new Uint8Array(),
			size: 0,
		});
	});

	it("are asked for raw, with every other header as any other call sends it", async () => {
		const bytes = new TextEncoder().encode("Raw.\n");
		await github.seed({ "raw.txt": bytes });
		const sent: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
			sent.push({ ...init });
			return github.fetch(input, init);
		});
		const usual = {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${github.token}`,
			"user-agent": "gateweave-agents",
			"x-github-api-version": "2022-11-28",
		};

		await readBlob(github.token, github.repository, await gitBlobId(bytes), 100);
		const tip = await branchHead(github.token, github.repository, "main");
		await createBranch(github.token, github.repository, "topic", tip.commit);

		// The calls that were there before are sent exactly what they were: a read, and a write.
		expect(sent).toEqual([
			{ headers: { ...usual, accept: "application/vnd.github.raw+json" } },
			{ headers: usual },
			{
				method: "POST",
				body: JSON.stringify({ ref: "refs/heads/topic", sha: tip.commit }),
				headers: { ...usual, "content-type": "application/json" },
			},
		]);
	});

	it("are refused by the answer's length, with the size, for a blob over the caller's limit", async () => {
		const bytes = new TextEncoder().encode("x".repeat(2000));
		await github.seed({ "big.txt": bytes });
		const id = await gitBlobId(bytes);

		// Only the length GitHub states gives the size: read to the limit, it would not be known.
		expect(await readBlob(github.token, github.repository, id, 1999)).toEqual({
			read: false,
			size: 2000,
		});
		expect(await readBlob(github.token, github.repository, id, 2000)).toMatchObject({
			read: true,
			size: 2000,
		});

		github.sendsLength = false;
		expect(await readBlob(github.token, github.repository, id, 1999)).toEqual({
			read: false,
			size: null,
		});
		expect(await readBlob(github.token, github.repository, id, 2000)).toMatchObject({
			read: true,
			size: 2000,
		});
	});

	it("are not judged by the length of a compressed answer, which is not the blob's", async () => {
		const bytes = new TextEncoder().encode("y".repeat(3000));
		const id = await gitBlobId(bytes);
		// As a runtime hands over an answer it has unpacked: the bytes, and the packed length.
		const packed = (length: string) =>
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(bytes, {
						headers: { "content-encoding": "gzip", "content-length": length },
					}),
			);

		packed("40");
		expect(await readBlob(github.token, github.repository, id, 2999)).toEqual({
			read: false,
			size: null,
		});
		packed("3500");
		expect(await readBlob(github.token, github.repository, id, 3000)).toMatchObject({
			read: true,
			size: 3000,
		});
	});

	it("of eight megabytes are read within two seconds", async () => {
		// A bound on time, not on memory: the base64 this replaced took 2.5 s for 20 MB in Node
		// and about 35 times the blob in memory. Nothing here measures memory.
		const bytes = new Uint8Array(8 * 1024 * 1024);
		for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) % 256;
		await github.seed({ "video.bin": bytes });
		const id = await gitBlobId(bytes);

		const started = performance.now();
		const read = await readBlob(github.token, github.repository, id, bytes.length);
		const took = performance.now() - started;

		if (!read.read) throw new Error("not read");
		expect(read.bytes.length).toBe(bytes.length);
		expect(read.bytes.every((byte, index) => byte === bytes[index])).toBe(true);
		expect(took).toBeLessThan(2000);
	});

	it("fail as GitHub's failure when the answer breaks off on the way", async () => {
		vi.stubGlobal("fetch", async () => {
			let sent = false;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent) return controller.error(new TypeError("terminated"));
						sent = true;
						controller.enqueue(new Uint8Array(10));
					},
				}),
			);
		});

		const failed = await readBlob(github.token, github.repository, "1".repeat(40), 100).catch(
			(error: unknown) => error,
		);
		expect(failed).toBeInstanceOf(GitHubError);
		expect(failed).toMatchObject({ status: 0 });
	});

	it("are not read to the end when the answer is far over the limit", async () => {
		const bytes = new Uint8Array(200_000).fill(120);
		await github.seed({ "huge.txt": bytes });
		let pulled = 0;
		vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
			const answer = await github.fetch(input, init);
			const whole = new Uint8Array(await answer.arrayBuffer());
			// The same answer, a kilobyte at a time, counting how much of it is asked for.
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (pulled >= whole.length) return controller.close();
					controller.enqueue(whole.slice(pulled, pulled + 1024));
					pulled += 1024;
				},
			});
			return new Response(body, { status: answer.status });
		});

		const read = await readBlob(github.token, github.repository, await gitBlobId(bytes), 1024);

		expect(read).toEqual({ read: false, size: null });
		expect(pulled).toBeLessThan(10_000);
	});

	it("fail when the blob is not there, or the answer is not the blob asked for", async () => {
		const missing = "1".repeat(40);
		await expect(readBlob(github.token, github.repository, missing, 10)).rejects.toMatchObject({
			status: 404,
		});

		vi.stubGlobal("fetch", async () => new Response("something else"));
		await expect(readBlob(github.token, github.repository, missing, 100)).rejects.toMatchObject({
			status: 502,
		});
	});
});

describe("a commit made without git", () => {
	it("leaves exactly an edit, a new file and a deletion, and every mode as it was", async () => {
		const outcome = await commitChanges(
			github.token,
			github.repository,
			await change({
				files: [
					{ path: "docs/guide.md", content: "New guide.\n" },
					{ path: "docs/new/first.md", content: "A new page.\n" },
				],
				deleted: ["docs/old.md"],
				author: { name: "Ada", email: "1+app[bot]@users.noreply.github.com" },
			}),
		);

		if (!outcome.committed) throw new Error(JSON.stringify(outcome));
		expect(github.branches.get("gateweave/c-1")).toBe(outcome.commit);
		expect(github.commitAt("gateweave/c-1")).toMatchObject({
			parents: [head.commit],
			message: "Change the guide",
			author: { name: "Ada", email: "1+app[bot]@users.noreply.github.com" },
		});

		const before = github.filesAt("main");
		const { "docs/old.md": _deleted, ...kept } = before;
		expect(github.filesAt("gateweave/c-1")).toEqual({
			...kept,
			"docs/guide.md": "New guide.\n",
			"docs/new/first.md": "A new page.\n",
		});
		const { "docs/old.md": _mode, ...modes } = github.modesAt("main");
		expect(github.modesAt("gateweave/c-1")).toEqual({ ...modes, "docs/new/first.md": "100644" });
		expect(github.modesAt("gateweave/c-1")["scripts/build.sh"]).toBe("100755");
		// The default branch is where it was.
		expect(github.branches.get("main")).toBe(head.commit);
		expect(github.requests.slice(-4)).toEqual([
			"GET /repos/acme/site/git/ref/heads/gateweave/c-1",
			"POST /repos/acme/site/git/trees",
			"POST /repos/acme/site/git/commits",
			"POST /repos/acme/site/git/refs",
		]);
	});

	it("keeps an executable file executable when its text changes", async () => {
		const outcome = await commitChanges(
			github.token,
			github.repository,
			await change({ files: [{ path: "scripts/build.sh", content: `${SCRIPT}pnpm test\n` }] }),
		);

		expect(outcome.committed).toBe(true);
		expect(github.modesAt("gateweave/c-1")["scripts/build.sh"]).toBe("100755");
		expect(github.filesAt("gateweave/c-1")["scripts/build.sh"]).toBe(`${SCRIPT}pnpm test\n`);
		expect(github.modesAt("gateweave/c-1")["scripts/run.sh"]).toBe("100755");
	});

	it("writes a byte order mark and Windows line ends as they were given", async () => {
		const text = "\uFEFFFirst\r\nİkinci\r\n";
		await commitChanges(
			github.token,
			github.repository,
			await change({ files: [{ path: "notes.txt", content: text }] }),
		);

		expect(github.bytesAt("gateweave/c-1")["notes.txt"]).toEqual(new TextEncoder().encode(text));
	});

	it("moves the branch forward for a second change, which names the whole difference", async () => {
		const first = await commitChanges(
			github.token,
			github.repository,
			await change({ files: [{ path: "docs/guide.md", content: "New guide.\n" }] }),
		);
		if (!first.committed) throw new Error(JSON.stringify(first));

		const second = await commitChanges(
			github.token,
			github.repository,
			await change({
				expected: first.commit,
				files: [{ path: "docs/guide.md", content: "New guide.\n" }],
				deleted: ["docs/old.md"],
			}),
		);

		if (!second.committed) throw new Error(JSON.stringify(second));
		expect(github.commitAt("gateweave/c-1")?.parents).toEqual([first.commit]);
		const { "docs/old.md": _deleted, ...kept } = github.filesAt("main");
		expect(github.filesAt("gateweave/c-1")).toEqual({ ...kept, "docs/guide.md": "New guide.\n" });
		expect(github.requests.at(-1)).toBe("PATCH /repos/acme/site/git/refs/heads/gateweave/c-1");
	});

	it("takes a change back with a commit, when the branch holds one and nothing differs now", async () => {
		const first = await commitChanges(
			github.token,
			github.repository,
			await change({ files: [{ path: "docs/guide.md", content: "New guide.\n" }] }),
		);
		if (!first.committed) throw new Error(JSON.stringify(first));

		const back = await commitChanges(
			github.token,
			github.repository,
			await change({ expected: first.commit }),
		);

		expect(back.committed).toBe(true);
		expect(github.filesAt("gateweave/c-1")).toEqual(github.filesAt("main"));
		expect(github.commitAt("gateweave/c-1")?.parents).toEqual([first.commit]);
	});

	it("drops an earlier change the second no longer names, while making another", async () => {
		const first = await commitChanges(
			github.token,
			github.repository,
			await change({
				files: [
					{ path: "docs/guide.md", content: "New guide.\n" },
					{ path: "docs/new.md", content: "A new page.\n" },
				],
				deleted: ["docs/old.md"],
			}),
		);
		if (!first.committed) throw new Error(JSON.stringify(first));

		// The guide is as it was, the deleted page is back, and the readme changes.
		const second = await commitChanges(
			github.token,
			github.repository,
			await change({
				expected: first.commit,
				files: [
					{ path: "docs/new.md", content: "A new page.\n" },
					{ path: "README.md", content: "# Site, again\n" },
				],
			}),
		);

		expect(second.committed).toBe(true);
		expect(github.filesAt("gateweave/c-1")).toEqual({
			...github.filesAt("main"),
			"docs/new.md": "A new page.\n",
			"README.md": "# Site, again\n",
		});
		expect(github.requests.slice(-6)).toEqual([
			"GET /repos/acme/site/git/ref/heads/gateweave/c-1",
			`GET /repos/acme/site/compare/${head.commit}...${first.commit}`,
			"POST /repos/acme/site/git/trees",
			`GET /repos/acme/site/git/commits/${first.commit}`,
			"POST /repos/acme/site/git/commits",
			"PATCH /repos/acme/site/git/refs/heads/gateweave/c-1",
		]);
	});

	it("counts a write as made when GitHub applied it and only its answer was lost", async () => {
		const edit = { files: [{ path: "docs/guide.md", content: "New guide.\n" }] };
		/** GitHub does what is asked, and the answer to a ref's write never arrives. */
		const losing = (lost: () => Response) =>
			vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
				const answer = await github.fetch(input, init);
				const ref = input.includes("/git/refs");
				return ref && init?.method !== undefined ? lost() : answer;
			});

		// The branch is made, and the connection is reset.
		losing(() => {
			throw new TypeError("fetch failed");
		});
		const first = await commitChanges(github.token, github.repository, await change(edit));
		expect(first).toEqual({ committed: true, commit: github.branches.get("gateweave/c-1") });
		if (!first.committed) throw new Error(JSON.stringify(first));

		// The branch is moved, and a gateway answers 502.
		losing(() => new Response("Bad Gateway", { status: 502 }));
		const second = await commitChanges(
			github.token,
			github.repository,
			await change({ ...edit, deleted: ["docs/old.md"], expected: first.commit }),
		);
		expect(second).toEqual({ committed: true, commit: github.branches.get("gateweave/c-1") });
		expect(github.commitAt("gateweave/c-1")?.parents).toEqual([first.commit]);
	});

	it("puts back commits someone took off the branch between its look and its move: a limit", async () => {
		// GitHub's REST API has no "move only if still at": unforced, it checks a fast-forward.
		const edit = { files: [{ path: "docs/guide.md", content: "New guide.\n" }] };
		const first = await commitChanges(github.token, github.repository, await change(edit));
		if (!first.committed) throw new Error(JSON.stringify(first));
		const second = await commitChanges(
			github.token,
			github.repository,
			await change({ ...edit, deleted: ["docs/old.md"], expected: first.commit }),
		);
		if (!second.committed) throw new Error(JSON.stringify(second));

		// Someone resets the branch to its first commit just before the third is put on it.
		github.before = (route) => {
			if (!route.startsWith("PATCH")) return;
			github.before = undefined;
			github.branches.set("gateweave/c-1", first.commit);
		};
		const third = await commitChanges(
			github.token,
			github.repository,
			await change({
				...edit,
				deleted: ["docs/old.md", "scripts/run.sh"],
				expected: second.commit,
			}),
		);

		// The move is a fast-forward from where they left it, so it is taken, and the commit
		// they dropped is on the branch again.
		if (!third.committed) throw new Error(JSON.stringify(third));
		expect(github.branches.get("gateweave/c-1")).toBe(third.commit);
		expect(github.commitAt("gateweave/c-1")?.parents).toEqual([second.commit]);
	});
});

describe("a commit that is refused", () => {
	const edit = { files: [{ path: "docs/guide.md", content: "New guide.\n" }] };

	it("says there is nothing to commit, and asks GitHub for nothing", async () => {
		const same = await change({
			files: [{ path: "docs/guide.md", content: SEED["docs/guide.md"] }],
		});
		const empty = await change();
		const asked = github.requests.length;

		expect(await commitChanges(github.token, github.repository, same)).toEqual({
			committed: false,
			reason: "nothing",
		});
		expect(await commitChanges(github.token, github.repository, empty)).toEqual({
			committed: false,
			reason: "nothing",
		});
		expect(github.requests.length).toBe(asked);
		expect(github.branches.has("gateweave/c-1")).toBe(false);
	});

	it("says there is nothing to commit when the branch already holds these files", async () => {
		const first = await commitChanges(github.token, github.repository, await change(edit));
		if (!first.committed) throw new Error(JSON.stringify(first));

		const again = await commitChanges(
			github.token,
			github.repository,
			await change({ ...edit, expected: first.commit }),
		);

		expect(again).toEqual({ committed: false, reason: "nothing" });
		expect(github.branches.get("gateweave/c-1")).toBe(first.commit);
	});

	it("writes nothing on a branch that holds a commit the caller did not expect", async () => {
		const first = await commitChanges(github.token, github.repository, await change(edit));
		if (!first.committed) throw new Error(JSON.stringify(first));

		// The caller thinks the branch is new, and it is not.
		expect(await commitChanges(github.token, github.repository, await change(edit))).toEqual({
			committed: false,
			reason: "branch",
			found: first.commit,
		});

		// Someone else pushed on top of the caller's commit.
		const theirs = await github.push("gateweave/c-1", "README.md", "# Theirs\n");
		const made = github.commits.size;
		const outcome = await commitChanges(
			github.token,
			github.repository,
			await change({ ...edit, deleted: ["docs/old.md"], expected: first.commit }),
		);
		expect(outcome).toEqual({ committed: false, reason: "branch", found: theirs });
		expect(github.branches.get("gateweave/c-1")).toBe(theirs);
		expect(github.commits.size).toBe(made);

		// The caller expects a commit, and the branch is gone.
		github.branches.delete("gateweave/c-1");
		expect(
			await commitChanges(
				github.token,
				github.repository,
				await change({ ...edit, expected: first.commit }),
			),
		).toEqual({ committed: false, reason: "branch", found: null });
	});

	it("gives way when the branch appears or moves between its look and its write", async () => {
		// The branch is made by someone else just before this run would make it.
		github.before = (route) => {
			if (route.startsWith("POST") && route.endsWith("/git/refs")) {
				github.branches.set("gateweave/c-1", head.commit);
			}
		};
		expect(await commitChanges(github.token, github.repository, await change(edit))).toEqual({
			committed: false,
			reason: "branch",
			found: head.commit,
		});

		// The branch is moved by someone else just before this run would move it.
		github.before = undefined;
		github.branches.delete("gateweave/c-1");
		const first = await commitChanges(github.token, github.repository, await change(edit));
		if (!first.committed) throw new Error(JSON.stringify(first));
		let theirs: string | undefined;
		github.before = async (route) => {
			if (!route.startsWith("PATCH")) return;
			github.before = undefined;
			theirs = await github.push("gateweave/c-1", "README.md", "# Theirs\n");
		};
		const outcome = await commitChanges(
			github.token,
			github.repository,
			await change({ ...edit, deleted: ["docs/old.md"], expected: first.commit }),
		);
		expect(theirs).toMatch(/^[0-9a-f]{40}$/);
		expect(outcome).toEqual({ committed: false, reason: "branch", found: theirs });
		expect(github.branches.get("gateweave/c-1")).toBe(theirs);
	});

	it("refuses the default branch and a base whose listing was cut, asking nothing", async () => {
		const input = await change(edit);
		const asked = github.requests.length;

		expect(
			await commitChanges(github.token, github.repository, { ...input, branch: "main" }),
		).toEqual({ committed: false, reason: "default-branch" });
		// Cut short, the listing may lack the symlink or the submodule a path would write over.
		expect(
			await commitChanges(github.token, github.repository, {
				...input,
				base: { ...input.base, truncated: true },
			}),
		).toEqual({ committed: false, reason: "truncated" });
		expect(github.requests.length).toBe(asked);
		expect(github.branches.get("main")).toBe(head.commit);
	});

	it("refuses a base the branch was not made from, which would carry others' changes", async () => {
		const first = await commitChanges(github.token, github.repository, await change(edit));
		if (!first.committed) throw new Error(JSON.stringify(first));

		// The default branch moves on, and the second turn reads its files there.
		const newer = await github.push("main", "README.md", "# Site, by someone else\n");
		head = { commit: newer, tree: github.commits.get(newer)?.tree ?? "" };
		const made = github.commits.size;
		const second = await commitChanges(
			github.token,
			github.repository,
			await change({ ...edit, deleted: ["docs/old.md"], expected: first.commit }),
		);

		expect(second).toEqual({ committed: false, reason: "base" });
		expect(github.branches.get("gateweave/c-1")).toBe(first.commit);
		expect(github.commits.size).toBe(made);
		expect(github.requests.at(-1)).toBe(`GET /repos/acme/site/compare/${newer}...${first.commit}`);
	});

	it("refuses a new path that differs only in case from one in the tree or in the change", async () => {
		const commit = await github.seed({ ...SEED, ".github/CODEOWNERS": "* @acme/site\n" });
		head = { commit, tree: github.commits.get(commit)?.tree ?? "" };
		const base = await change();
		const asked = github.requests.length;
		const file = (path: string) => ({ path, content: "x\n" });
		for (const [files, path, twin] of [
			[[file("readme.md")], "readme.md", "README.md"],
			[[file("Docs/guide.md")], "Docs/guide.md", "docs"],
			[[file("docs/Guide.md")], "docs/Guide.md", "docs/guide.md"],
			[[file(".GitHub/Workflows/x.yml")], ".GitHub/Workflows/x.yml", ".github"],
			[[file("notes/a.md"), file("Notes/b.md")], "Notes/b.md", "notes"],
			[[file("new.md"), file("NEW.md")], "NEW.md", "new.md"],
		] as const) {
			const outcome = await commitChanges(github.token, github.repository, { ...base, files });
			expect(outcome).toEqual({
				committed: false,
				reason: "path",
				path,
				message: `differs only in case from ${twin}`,
			});
		}
		expect(github.requests.length).toBe(asked);

		// The tree's own spelling, and a second new file in a new folder, are no collision.
		const taken = await commitChanges(github.token, github.repository, {
			...base,
			files: [file("README.md"), file("docs/guide.md"), file("notes/a.md"), file("notes/b.md")],
		});
		expect(taken.committed).toBe(true);
	});

	it("refuses text that is not Unicode, which GitHub would have to change to store", async () => {
		const outcome = await commitChanges(
			github.token,
			github.repository,
			await change({ files: [{ path: "docs/guide.md", content: "half \ud83d of a pair\n" }] }),
		);

		expect(outcome).toMatchObject({ committed: false, reason: "path", path: "docs/guide.md" });
		expect(outcome).toHaveProperty("message", expect.stringContaining("not Unicode"));
		expect(github.branches.has("gateweave/c-1")).toBe(false);
	});

	it("passes on GitHub's refusal with its status and words, and never the token", async () => {
		const input = await change(edit);

		const wrong = await commitChanges("ghs_wrong_token", github.repository, input);
		expect(wrong).toMatchObject({ committed: false, reason: "refused", status: 401 });
		expect(JSON.stringify(wrong)).toContain("Bad credentials");
		expect(JSON.stringify(wrong)).not.toContain("ghs_wrong_token");

		const readOnly = await commitChanges(github.readToken, github.repository, input);
		expect(readOnly).toMatchObject({ committed: false, reason: "refused", status: 403 });
		expect(JSON.stringify(readOnly)).toContain("Resource not accessible by integration");
		expect(JSON.stringify(readOnly)).not.toContain(github.readToken);
		expect(JSON.stringify(readOnly)).not.toContain("New guide.");

		// A base GitHub does not hold: the tree is refused.
		const lost = await commitChanges(github.token, github.repository, {
			...input,
			base: { ...input.base, tree: "9".repeat(40) },
		});
		expect(lost).toMatchObject({ committed: false, reason: "refused", status: 422 });

		vi.stubGlobal("fetch", async () => {
			throw new TypeError("fetch failed");
		});
		expect(await commitChanges(github.token, github.repository, input)).toMatchObject({
			committed: false,
			reason: "refused",
			status: 0,
		});
		vi.stubGlobal("fetch", github.fetch);
		expect(github.branches.has("gateweave/c-1")).toBe(false);
	});

	it("refuses a workflow before asking, and says GitHub's no when told the token may", async () => {
		const workflow = { path: ".github/workflows/ci.yml", content: "on: push\n" };
		const input = await change({ files: [workflow] });
		const asked = github.requests.length;

		const refused = await commitChanges(github.token, github.repository, input);
		expect(refused).toMatchObject({
			committed: false,
			reason: "path",
			path: ".github/workflows/ci.yml",
		});
		expect(refused).toHaveProperty("message", expect.stringContaining("Workflows permission"));
		expect(github.requests.length).toBe(asked);

		// The caller says the token may, and GitHub knows better.
		const tried = await commitChanges(
			github.token,
			github.repository,
			await change({ files: [workflow], workflows: true }),
		);
		expect(tried).toMatchObject({ committed: false, reason: "refused", status: 403 });
		expect(github.branches.has("gateweave/c-1")).toBe(false);

		github.workflows = true;
		const taken = await commitChanges(
			github.token,
			github.repository,
			await change({ files: [workflow], workflows: true }),
		);
		expect(taken.committed).toBe(true);
		// A file beside the folder is not a workflow.
		expect(
			await commitChanges(
				github.token,
				github.repository,
				await change({
					branch: "gateweave/c-2",
					files: [{ path: ".github/workflows.md", content: "Notes.\n" }],
				}),
			),
		).toMatchObject({ committed: true });
	});

	it("never writes over or takes out a symlink or a submodule, or a file under one", async () => {
		const base = await change();
		const asked = github.requests.length;
		for (const [input, path, words] of [
			[{ files: [{ path: "CLAUDE.md", content: "Text.\n" }] }, "CLAUDE.md", "a symlink"],
			[{ deleted: ["CLAUDE.md"] }, "CLAUDE.md", "a symlink"],
			[{ files: [{ path: "vendor/lib", content: "Text.\n" }] }, "vendor/lib", "a submodule"],
			[{ deleted: ["vendor/lib"] }, "vendor/lib", "a submodule"],
			[
				{ files: [{ path: "vendor/lib/a.c", content: "int a;\n" }] },
				"vendor/lib/a.c",
				"a submodule",
			],
			[{ files: [{ path: "CLAUDE.md/x", content: "x\n" }] }, "CLAUDE.md/x", "a symlink"],
			[{ files: [{ path: "README.md/x", content: "x\n" }] }, "README.md/x", "a file"],
			[{ files: [{ path: "docs", content: "x\n" }] }, "docs", "a folder"],
			[{ deleted: ["docs/never.md"] }, "docs/never.md", "not a file in the repository"],
			[{ deleted: ["docs"] }, "docs", "not a file in the repository"],
			[
				{ files: [{ path: "docs/guide.md", content: "x\n" }], deleted: ["docs/guide.md"] },
				"docs/guide.md",
				"twice",
			],
			[{ files: [{ path: "docs/../../x", content: "x\n" }] }, "docs/../../x", ".."],
			[{ deleted: [".git/config"] }, ".git/config", ".git"],
		] as const) {
			const outcome = await commitChanges(github.token, github.repository, { ...base, ...input });
			expect(outcome).toMatchObject({ committed: false, reason: "path", path });
			expect(outcome).toHaveProperty("message", expect.stringContaining(words));
		}
		expect(github.requests.length).toBe(asked);
		expect(github.branches.has("gateweave/c-1")).toBe(false);
	});
});

describe("the stand-in for GitHub", () => {
	it("refuses a wrong token, a tree on a base it does not hold and a move that is not forward", async () => {
		await expect(readTree("ghs_wrong", github.repository, head.tree)).rejects.toMatchObject({
			status: 401,
		});
		const files = [{ path: "a.md", content: "A.\n" }];
		await expect(
			createCommit(github.token, github.repository, {
				parent: head.commit,
				tree: "9".repeat(40),
				files,
				message: "A",
			}),
		).rejects.toMatchObject({ status: 422 });
		await expect(
			createCommit(github.token, github.repository, {
				parent: "9".repeat(40),
				tree: head.tree,
				files,
				message: "A",
			}),
		).rejects.toMatchObject({ status: 422 });
		// Taking out a path that is not there.
		await expect(
			createCommit(github.token, github.repository, {
				...head,
				parent: head.commit,
				files: [],
				deleted: ["nowhere.md"],
				message: "A",
			}),
		).rejects.toMatchObject({ status: 422 });

		// Two commits side by side: the branch at one cannot move to the other unforced.
		const one = await createCommit(github.token, github.repository, {
			parent: head.commit,
			tree: head.tree,
			files,
			message: "One",
		});
		const other = await createCommit(github.token, github.repository, {
			parent: head.commit,
			tree: head.tree,
			files: [{ path: "b.md", content: "B.\n", mode: "100755" }],
			message: "Other",
		});
		github.branches.set("topic", one);
		await expect(
			moveBranch(github.token, github.repository, "topic", other, false),
		).rejects.toMatchObject({ status: 422 });
		expect(github.branches.get("topic")).toBe(one);
		await moveBranch(github.token, github.repository, "topic", other, true);
		expect(github.modesAt("topic")["b.md"]).toBe("100755");
	});

	it("refuses .git at any depth and in any case, and branch names Git would not take", async () => {
		for (const path of [".git/config", "vendor/.GIT/config", "docs/.Git"]) {
			await expect(
				createCommit(github.token, github.repository, {
					parent: head.commit,
					tree: head.tree,
					files: [{ path, content: "x\n" }],
					message: "A",
				}),
			).rejects.toMatchObject({ status: 422 });
		}
		for (const name of [
			"",
			"-topic",
			"topic/",
			"topic.lock",
			"a..b",
			"a b",
			"a\tb",
			"a\u007fb",
			".hidden/x",
			"a//b",
			"topic.",
			"a:b",
		]) {
			await expect(
				createBranch(github.token, github.repository, name, head.commit),
				JSON.stringify(name),
			).rejects.toMatchObject({ status: 422 });
		}
		await createBranch(github.token, github.repository, "gateweave/c-1", head.commit);
		expect([...github.branches.keys()]).toEqual(["main", "gateweave/c-1"]);
	});

	it("answers 409 for the Git database of a repository with no branch yet", async () => {
		vi.stubGlobal("fetch", new FakeGit().fetch);

		for (const ask of [
			() => branchCommit(github.token, github.repository, "main"),
			() => readTree(github.token, github.repository, head.tree),
			() => readBlob(github.token, github.repository, "1".repeat(40), 10),
			() => createBranch(github.token, github.repository, "topic", head.commit),
		]) {
			await expect(ask()).rejects.toMatchObject({ status: 409 });
		}
	});
});

describe("a path in a repository", () => {
	it("is relative, divided by slashes, with no part empty, dotted or .git", () => {
		for (const path of [
			"README.md",
			"docs/guide.md",
			".github/workflows/ci.yml",
			".gitignore",
			"src/.gitkeep",
			"a b/ç.md",
			".gitattributes",
			".github/git~1.md",
			"docs/.gitmodules.md",
			"console.log",
			"com10",
			"auxiliary/null/x",
			"a".repeat(255),
			`${"d/".repeat(2047)}f`,
		]) {
			expect(repositoryPathProblem(path), path).toBeNull();
		}
		for (const path of [
			"",
			"/etc/passwd",
			"/workspace/repo/README.md",
			"docs//guide.md",
			"docs/",
			"./README.md",
			"docs/./guide.md",
			"..",
			"../outside",
			"docs/../../outside",
			"docs/..",
			".git",
			".git/config",
			".GIT/hooks/pre-commit",
			"vendor/.git/config",
			"docs\\guide.md",
			"..\\outside",
		]) {
			expect(repositoryPathProblem(path), JSON.stringify(path)).toEqual(expect.any(String));
		}
	});

	it("is no name a Git client refuses, or a file system reads as another, each said in words", () => {
		for (const [path, words] of [
			// What Windows makes of a name: it drops trailing dots and spaces, and has short names.
			[".git./config", ".git"],
			[".git /config", ".git"],
			[".git. . ./config", ".git"],
			["docs/.GIT./x", ".git"],
			["git~1/config", ".git"],
			["GIT~1/config", ".git"],
			["vendor/Git~1", ".git"],
			// What macOS makes of one: it ignores these characters.
			[".g\u200cit/config", ".git"],
			[".git\u200d/config", ".git"],
			["\u200e.git/config", ".git"],
			[".gi\u200ft/config", ".git"],
			[".\u202agit/config", ".git"],
			[".git\u202e/config", ".git"],
			[".g\u206ait/config", ".git"],
			[".gi\u206ft/config", ".git"],
			["\ufeff.GIT/config", ".git"],
			// The file that says where submodules come from.
			[".gitmodules", ".gitmodules"],
			[".GitModules", ".gitmodules"],
			["vendor/.gitmodules", ".gitmodules"],
			[".gitmodules.", ".gitmodules"],
			[".gitmodules ", ".gitmodules"],
			[".git\u200cmodules", ".gitmodules"],
			["\ufeff.gitmodules", ".gitmodules"],
			["gitmod~1", ".gitmodules"],
			["GITMOD~4", ".gitmodules"],
			["gi7eba~1", ".gitmodules"],
			// A stream of another file, on NTFS.
			["docs/guide.md:hidden", "colon"],
			[".git::$INDEX_ALLOCATION/config", "colon"],
			["C:/x", "colon"],
			// Control characters.
			["a\0b", "control character"],
			["docs/a\nb.md", "control character"],
			["docs/a\tb.md", "control character"],
			["docs/a\u001fb.md", "control character"],
			["docs/a\u007fb.md", "control character"],
			// A name's end that Windows drops.
			["docs/guide.md.", "ending in a dot or a space"],
			["docs/guide.md ", "ending in a dot or a space"],
			["docs /guide.md", "ending in a dot or a space"],
			["docs/...", "ending in a dot or a space"],
			// Devices.
			["CON", "device"],
			["con.txt", "device"],
			["docs/PRN", "device"],
			["aux/x.md", "device"],
			["Nul.tar.gz", "device"],
			["COM1", "device"],
			["com9.log", "device"],
			["lpt1", "device"],
			["docs/LPT9.md", "device"],
			// Lengths.
			["a".repeat(256), "255 bytes"],
			[`docs/${"ç".repeat(128)}`, "255 bytes"],
			[`${"d/".repeat(2048)}f`, "4,096 bytes"],
		] as const) {
			expect(repositoryPathProblem(path), JSON.stringify(path)).toEqual(
				expect.stringContaining(words),
			);
		}
	});
});
