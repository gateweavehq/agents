import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeGit } from "@gateweave/agents-github/testing";
import { type MoveTarget, moveWorkspace, type WorkspaceMove } from "@gateweave/agents-registry";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName, destroyConversationObject, MOVED_IN } from "../src";
import {
	AUTHOR,
	BRANCH,
	inConversation,
	newConversation,
	repositoryOf,
	rowCounts,
	storeOver,
	useGitHub,
} from "./file-store-support";
import { anthropicStream, ask, connect, fakeModel, KEY } from "./support";

// The files store's tables are the conversation's own (`../src/file-store.ts`), so what deletes a
// conversation, moves it to another place and backs it up has to take them along. None of the
// three names a table: deleting empties the object, a move copies every table it finds and a
// backup lists the tables itself. These hold each to that, on a real `ConversationAgent`.

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const REPO = "/workspace/repo";

const FILES = {
	"README.md": "# Site\n\nA needle in the readme.\n",
	"docs/guide.md": "# Guide\n",
	"docs/old.md": "old\n",
	"bin/run.sh": "\uFEFF#!/bin/sh\r\necho one\r\n",
};

/**
 * Fills a conversation's storage as a turn would: a checkout, a file read, others fetched by a
 * search, a file edited, one added and one deleted. Every table of the store then holds rows.
 */
async function workOn(fake: FakeGit, name: string): Promise<void> {
	await inConversation(async (storage) => {
		const { store } = storeOver(storage, fake);
		expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: true });
		await store.readFile(`${REPO}/README.md`);
		await store.search({ pattern: "needle", path: `${REPO}/docs`, ignoreCase: false });
		await store.writeFile(`${REPO}/bin/run.sh`, "\uFEFF#!/bin/sh\r\necho 1\r\n");
		await store.writeFile(`${REPO}/docs/new.md`, "new\n");
		await store.deleteFile(`${REPO}/docs/old.md`);
		expect(rowCounts(storage)).toEqual({ checkout: 1, listing: 1, blobs: 4, changes: 3 });
	}, name);
}

/** Every row of the store's tables, bytes as hexadecimal, to compare two objects' with. */
function rowsOf(storage: DurableObjectStorage): Record<string, unknown[]> {
	const tables = ["file_checkout", "file_listing", "file_blobs", "file_changes"];
	const hex = (value: unknown) =>
		value instanceof ArrayBuffer
			? [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
			: value;
	return Object.fromEntries(
		tables.map((table) => [
			table,
			storage.sql
				.exec(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
				.toArray()
				.map((row) =>
					Object.fromEntries(Object.entries(row).map(([key, value]) => [key, hex(value)])),
				),
		]),
	);
}

function fileTables(storage: DurableObjectStorage): string[] {
	return storage.sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'file!_%' ESCAPE '!' ORDER BY name",
		)
		.toArray()
		.map((row) => row.name);
}

describe("a conversation that holds a repository's files", () => {
	it("leaves no file rows behind when it is deleted", async () => {
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		const name = newConversation();
		await workOn(fake, name);
		const stub = await getAgentByName(env.CONVERSATIONS, name);

		await destroyConversationObject(stub);

		// The object aborts itself just after answering here, so a call right away can still meet that.
		const left = await vi.waitFor(async () => {
			const again = await getAgentByName(env.CONVERSATIONS, name);
			return runInDurableObject(again as never, (_instance: unknown, state: DurableObjectState) => {
				const tables = fileTables(state.storage);
				// A table that outlived the delete would show here with its rows.
				return tables.map((table) => ({
					table,
					rows: state.storage.sql.exec(`SELECT count(*) AS n FROM ${table}`).one().n,
				}));
			});
		});
		expect(left).toEqual([]);

		// The conversation starts over with nothing: no checkout, so nothing to read.
		await inConversation(async (storage) => {
			const { store } = storeOver(storage, fake);
			expect(await store.readFile(`${REPO}/README.md`)).toEqual({
				error: "No repository is checked out here.",
			});
			expect(rowCounts(storage)).toEqual({ checkout: 0, listing: 0, blobs: 0, changes: 0 });
		}, name);
	});

	it("arrives with them when its workspace moves, and goes on from them", async () => {
		// A workspace whose registry lists the conversation, as a move finds its conversations there.
		const workspaceId = crypto.randomUUID();
		const registry = env.REGISTRY.getByName(workspaceId);
		const rules = await registry.createLibraryAsset({
			kind: "instructions",
			name: "rules",
			text: "Answer in one word.\n",
		});
		const agent = await registry.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: { assetId: rules, version: 1 },
		});
		await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const conversationId = (await registry.startConversation(agent.id, "user-ada"))?.id ?? "";
		const name = conversationName(workspaceId, conversationId);
		const stub = await getAgentByName(env.CONVERSATIONS, name);
		fakeModel(() => anthropicStream("Looks good."));
		const socket = await connect(stub);
		expect((await ask(socket, "Review my change, please.")).error).toBeNull();
		socket.close();
		vi.restoreAllMocks();

		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		await workOn(fake, name);
		const before = await inConversation(async (storage) => rowsOf(storage), name);
		expect(before.file_changes).toHaveLength(3);

		const moved = crypto.randomUUID();
		const restarting = (target: MoveTarget): MoveTarget => ({
			moveIn: (token, manifest) => target.moveIn(token, manifest),
			moveWrite: (token, page) => target.moveWrite(token, page),
			moveWriteKeys: (token, entries) => target.moveWriteKeys(token, entries),
			moveCheck: (token, manifest) => target.moveCheck(token, manifest),
			moveDigest: () => target.moveDigest(),
			async moveStart(place) {
				try {
					await target.moveStart(place);
				} catch (error) {
					if ((error instanceof Error ? error.message : String(error)) !== MOVED_IN) throw error;
				}
			},
		});
		const move: WorkspaceMove = {
			registry: { from: registry, to: env.REGISTRY.getByName(moved) },
			conversation: (id) => ({
				from: env.CONVERSATIONS.getByName(conversationName(workspaceId, id)),
				to: restarting(env.CONVERSATIONS.getByName(conversationName(moved, id))),
			}),
			from: "",
			to: "elsewhere",
			record: async () => {},
		};
		// Small pages, so the files' rows cross in several.
		const report = await moveWorkspace(move, { pageChars: 200, retryMs: 1 });
		expect(report).toMatchObject({ moved: true, conversations: 1 });

		const copy = conversationName(moved, conversationId);
		// The copy restarts as the move ends, so a call right away can still meet that.
		const after = await vi.waitFor(() => inConversation(async (storage) => rowsOf(storage), copy));
		expect(after).toEqual(before);

		// It goes on where the conversation was: no checkout again, the edit as written, and a push.
		await inConversation(async (storage) => {
			const { store } = storeOver(storage, fake);
			fake.requests.length = 0;
			expect(await store.checkout(repositoryOf(fake), BRANCH)).toEqual({ checkedOut: false });
			const read = await store.readFile(`${REPO}/bin/run.sh`);
			expect(read).toEqual({ content: "\uFEFF#!/bin/sh\r\necho 1\r\n" });
			expect(await store.readFile(`${REPO}/README.md`)).toEqual({ content: FILES["README.md"] });
			expect(fake.requests).toEqual([]);
			expect(await store.push(BRANCH, "After the move", AUTHOR)).toMatchObject({ pushed: true });
		}, copy);
		const { "docs/old.md": _gone, ...kept } = FILES;
		expect(fake.filesAt(BRANCH)).toEqual({
			...kept,
			"bin/run.sh": "\uFEFF#!/bin/sh\r\necho 1\r\n",
			"docs/new.md": "new\n",
		});
	});

	it("is backed up with them: a dump lists the tables and reads their rows, bytes and all", async () => {
		const fake = new FakeGit();
		await fake.seed(FILES);
		useGitHub(fake);
		const name = newConversation();
		await workOn(fake, name);
		const stub = await getAgentByName(env.CONVERSATIONS, name);

		// What Gateweave Backup sends: the list of tables, then each table's rows as SQLite quotes
		// them, so bytes come as a hexadecimal literal.
		const [tables = [], changes = [], blobs = [], listing = [], checkout = []] =
			await stub.backupRead([
				"PRAGMA table_list",
				`SELECT quote(rowid) AS r, quote("path") || ',' || quote("bytes") AS v FROM "file_changes" ORDER BY rowid`,
				`SELECT quote("kind") AS k, quote("bytes") AS v FROM "file_blobs" ORDER BY rowid`,
				`SELECT quote("part") AS r, length("bytes") AS n FROM "file_listing" ORDER BY rowid`,
				`SELECT "owner", "name", "branch", "tip" FROM "file_checkout"`,
			]);
		const listed = tables.map((table) => table.name);
		for (const table of ["file_checkout", "file_listing", "file_blobs", "file_changes"]) {
			expect(listed).toContain(table);
		}
		const hex = (text: string) =>
			[...new TextEncoder().encode(text)]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("")
				.toUpperCase();
		expect(changes.map((row) => row.v)).toEqual([
			`'bin/run.sh',X'${hex("\uFEFF#!/bin/sh\r\necho 1\r\n")}'`,
			`'docs/new.md',X'${hex("new\n")}'`,
			"'docs/old.md',NULL",
		]);
		expect(blobs.filter((row) => row.k === "'text'")).toHaveLength(4);
		expect(blobs.map((row) => row.v)).toContain(`X'${hex(FILES["README.md"])}'`);
		expect(listing).toHaveLength(1);
		expect(Number(listing[0]?.n)).toBeGreaterThan(0);
		expect(checkout).toEqual([{ owner: "acme", name: "site", branch: BRANCH, tip: null }]);
	});
});
