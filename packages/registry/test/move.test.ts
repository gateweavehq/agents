import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SANDBOX_SECOND_PRICE } from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOVING_MESSAGE, moveWorkspace, type RegistryDO, type WorkspaceMove } from "../src";

// Moving a registry to another Durable Object (`move.ts`), as the app does to keep a workspace in
// a jurisdiction. Local workerd has no jurisdictions, so these move a registry to another name; the
// conversations' side is in the runtime package's tests.

const KEY = "sk-proj-abcdefgh";

afterEach(() => {
	vi.restoreAllMocks();
});

/** A move of a registry without conversations, from one name to another. */
function moving(from: string, to: string, recorded: string[] = []): WorkspaceMove {
	return {
		registry: { from: env.REGISTRY.getByName(from), to: env.REGISTRY.getByName(to) },
		conversation: () => {
			throw new Error("This workspace has no conversations.");
		},
		from: "",
		to: "eu",
		record: async () => {
			recorded.push(to);
		},
	};
}

/** How a call failed: its error's message, or null if it didn't. */
async function failure(call: Promise<unknown>): Promise<string | null> {
	return call.then(
		() => null,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

/** The provider answers a check of the key by listing two models. */
function providerAnswers() {
	const keys: (string | null)[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		keys.push(new Headers(init?.headers).get("authorization"));
		return Response.json({ data: [{ id: "gpt-a" }, { id: "gpt-b" }] });
	});
	return keys;
}

describe("moving a registry", () => {
	it("copies every table and key, and its secrets still open where it went", async () => {
		const from = crypto.randomUUID();
		const to = crypto.randomUUID();
		const source = env.REGISTRY.getByName(from);
		await source.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
		await source.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief.\n" });
		// A table without rowids, read on by offset, and one the code made only here, which the copy
		// makes from the source's own SQL, with its index.
		await runInDurableObject(source, (_instance: RegistryDO, state) => {
			state.storage.sql.exec(
				"CREATE TABLE notes (topic TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (topic, line)) WITHOUT ROWID",
			);
			state.storage.sql.exec("CREATE INDEX notes_text ON notes (text)");
			for (let line = 0; line < 60; line++) {
				state.storage.sql.exec(
					"INSERT INTO notes (topic, line, text) VALUES (?, ?, ?)",
					line % 2 === 0 ? "even" : "odd",
					line,
					`Line ${line}: ${"words ".repeat(10)}`,
				);
			}
		});
		const recorded: string[] = [];

		const report = await moveWorkspace(moving(from, to, recorded), {
			pageChars: 500,
			retryMs: 1,
		});
		expect(report).toMatchObject({ moved: true, conversations: 0, finished: false });
		expect(report.moved && report.rows).toBeGreaterThan(60);
		expect(recorded).toEqual([to]);

		const target = env.REGISTRY.getByName(to);
		expect(await target.listProviderKeys()).toEqual(await source.listProviderKeys());
		expect((await target.listLibrary()).map((entry) => entry.asset.name)).toEqual(["rules"]);
		const copied = await runInDurableObject(target, (_instance: RegistryDO, state) => ({
			notes: state.storage.sql
				.exec<{ topic: string; line: number }>("SELECT topic, line FROM notes ORDER BY line")
				.toArray(),
			index: state.storage.sql
				.exec("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'notes_text'")
				.toArray().length,
		}));
		expect(copied.notes).toHaveLength(60);
		expect(copied.notes[59]).toEqual({ topic: "odd", line: 59 });
		expect(copied.index).toBe(1);

		// The key was sealed under the old object's id, which came over with it.
		const keys = providerAnswers();
		expect(await target.checkProviderKey("openai")).toMatchObject({ check: { ok: true } });
		expect(keys).toEqual([`Bearer ${KEY}`]);
		// The copy takes writes, and new secrets seal and open as before.
		await target.saveProviderKey({ provider: "openai", key: "sk-proj-ijklmnop" }, "Grace");
		expect(await target.checkProviderKey("openai")).toMatchObject({ check: { ok: true } });
		expect(keys[1]).toBe("Bearer sk-proj-ijklmnop");
	});

	it("leaves the old registry sealed, and a second move only finishes into the same copy", async () => {
		const from = crypto.randomUUID();
		const to = crypto.randomUUID();
		const source = env.REGISTRY.getByName(from);
		await source.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief.\n" });
		await moveWorkspace(moving(from, to), { retryMs: 1 });

		expect(
			await failure(
				source.createLibraryAsset({ kind: "instructions", name: "late", text: "Too late.\n" }),
			),
		).toContain(MOVING_MESSAGE);
		expect(await runDurableObjectAlarm(source)).toBe(false);
		// Reads still answer, from what it held when it sealed.
		expect((await source.listLibrary()).map((entry) => entry.asset.name)).toEqual(["rules"]);

		const recorded: string[] = [];
		expect(await moveWorkspace(moving(from, to, recorded), { retryMs: 1 })).toMatchObject({
			moved: true,
			finished: true,
		});
		expect(recorded).toEqual([to]);
	});

	it("won't copy into a registry that holds a workspace", async () => {
		const from = crypto.randomUUID();
		const to = crypto.randomUUID();
		const source = env.REGISTRY.getByName(from);
		await source.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief.\n" });
		const target = env.REGISTRY.getByName(to);
		const agent = await target.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
		});
		await target.startConversation(agent.id, "user-ada");

		expect(await failure(moveWorkspace(moving(from, to), { retryMs: 1 }))).toBe(
			"This registry holds a workspace, so it can't take another's rows.",
		);
		// The source thawed and works where it is.
		await source.createLibraryAsset({ kind: "instructions", name: "after", text: "Fine.\n" });
		expect((await target.listConversations("user-ada")).length).toBe(1);
	});
});

describe("moving the sandbox meter", () => {
	it("keeps each workspace's larger figure and every share either meter told of", async () => {
		const old = env.SANDBOX_METER.getByName(crypto.randomUUID());
		const fresh = env.SANDBOX_METER.getByName(crypto.randomUUID());
		const budget = 1000 * SANDBOX_SECOND_PRICE;
		expect((await old.record("2026-11", "ws-1", 800, budget)).passed).toEqual([80]);
		await old.record("2026-11", "ws-2", 50, budget);
		// The new meter heard from ws-2 since, with a larger figure.
		await fresh.record("2026-11", "ws-2", 100, budget);

		const readings = await old.readings();
		await fresh.takeReadings(readings);
		await old.clear();
		expect(await old.readings()).toEqual([]);
		// Taking them again changes nothing.
		await fresh.takeReadings(readings);

		// 800 from ws-1 and 150 from ws-2: past the 80% share, which the old meter told of.
		const reading = await fresh.record("2026-11", "ws-2", 150, budget);
		expect(reading.spent).toBeCloseTo(950 * SANDBOX_SECOND_PRICE, 12);
		expect(reading.passed).toEqual([]);
		expect((await fresh.record("2026-11", "ws-1", 900, budget)).passed).toEqual([100]);
	});
});
