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
	it("erases the sealed registry's tables and secrets and keeps its seal across a restart", async () => {
		const from = crypto.randomUUID();
		const to = crypto.randomUUID();
		const source = env.REGISTRY.getByName(from);
		await source.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
		await runInDurableObject(source, (_instance, { storage }) => {
			storage.kv.put("sealed-secret", { ciphertext: "test" });
		});
		await moveWorkspace(moving(from, to), { retryMs: 1 });
		expect(await source.moveForget()).toBe("forgotten");
		await runInDurableObject(source, (_instance, { storage }) => {
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_schema WHERE name NOT IN ('_cf_KV', '_cf_METADATA', 'sqlite_sequence')",
					)
					.toArray(),
			).toEqual([]);
			expect([...storage.kv.list()]).toEqual([
				["move.sealed", { to: "eu", at: expect.any(Number), forgottenAt: expect.any(Number) }],
			]);
		});
		await runInDurableObject(source, (_instance, state) => state.abort("restart")).catch(() => {});
		const restarted = env.REGISTRY.get(source.id);
		expect(await restarted.conversationIds()).toEqual([]);
		expect(await restarted.moveForget()).toBe("already");
		await runInDurableObject(restarted, async (registry, { storage }) => {
			expect(() =>
				registry.createLibraryAsset({ kind: "instructions", name: "late", text: "Too late." }),
			).toThrow(MOVING_MESSAGE);
			expect(await storage.getAlarm()).toBeNull();
		});
		expect(await env.REGISTRY.getByName(to).listProviderKeys()).toHaveLength(1);
	});

	it("answers empty without writing a seal and refuses live, frozen and importing registries", async () => {
		const live = env.REGISTRY.getByName(crypto.randomUUID());
		const empty = env.REGISTRY.getByName(crypto.randomUUID());
		await live.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
		async function refuses(stub: Registry) {
			await runInDurableObject(stub, async (registry) => {
				await expect(registry.moveForget()).rejects.toThrow("Only a sealed object");
			});
		}
		await refuses(live);
		const before = await empty.moveDigest();
		expect(await empty.moveForget()).toBe("empty");
		expect(await empty.moveDigest()).toEqual(before);
		await runInDurableObject(empty, (_instance, { storage }) => {
			expect([...storage.kv.list()]).toEqual([]);
		});
		expect(await live.listProviderKeys()).toHaveLength(1);
		const token = crypto.randomUUID();
		const out = await live.moveOut(token, "eu");
		if (!("frozen" in out) || !out.frozen) throw new Error("Expected a freeze");
		await refuses(live);
		expect(await live.moveRead(token, { table: 0, after: null })).toBeDefined();
		await empty.moveIn(token, out.manifest);
		await refuses(empty);
		await empty.moveWriteKeys(token, [["imported", true]]);
	});

	it("moves a workspace back into a registry that was forgotten", async () => {
		const from = crypto.randomUUID();
		const to = crypto.randomUUID();
		const source = env.REGISTRY.getByName(from);
		await source.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
		await moveWorkspace(moving(from, to), { retryMs: 1 });
		expect(await source.moveForget()).toBe("forgotten");
		await runInDurableObject(source, (_instance, state) => state.abort("restart")).catch(() => {});
		const reopened = env.REGISTRY.getByName(from);
		const returning = { ...moving(to, from), from: "eu", to: "" };
		expect(await moveWorkspace(returning, { retryMs: 1 })).toMatchObject({ moved: true });
		expect(await reopened.listProviderKeys()).toHaveLength(1);
		expect(
			await reopened.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief." }),
		).toBeTruthy();
	});

	it("keeps the list of forgotten conversations through a restart and waits for the rest", async () => {
		const source = env.REGISTRY.getByName(crypto.randomUUID());
		const agent = await source.createAgent({
			name: "Reviewer",
			description: null,
			provider: "openai",
			model: "gpt-5",
			instructions: null,
		});
		const first = await source.startConversation(agent.id, "ada");
		const second = await source.startConversation(agent.id, "ada");
		if (!first || !second) throw new Error("Expected two conversations");
		const token = crypto.randomUUID();
		await source.moveOut(token, "eu");
		await source.moveSeal(token, "eu");
		await source.moveNoteForgotten([first.id]);
		await runInDurableObject(source, (_instance, state) => state.abort("restart")).catch(() => {});
		const restarted = env.REGISTRY.get(source.id);
		expect(await restarted.moveConversationsToForget()).toEqual([second.id]);
		await runInDurableObject(restarted, async (registry) => {
			await expect(registry.moveForget()).rejects.toThrow("still lists conversations");
		});
		await restarted.moveNoteForgotten([second.id]);
		expect(await restarted.moveForget()).toBe("forgotten");
	});

	it("copies every table and key, and its secrets still open where it went", async () => {
		const from = crypto.randomUUID();
		const to = crypto.randomUUID();
		const source = env.REGISTRY.getByName(from);
		await source.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
		await source.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief.\n" });
		// A full-text index, which is copied by its content: its shadow tables are not.
		await source.addMemory({ text: "Deploys go out on Tuesdays.", kind: "decision" }, "user-ada");
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
		// The memory is found by its words where it went, once, and the index takes new ones.
		expect((await target.listMemories({ search: "deploys" })).memories).toHaveLength(1);
		await target.addMemory({ text: "Deploys need a review.", kind: "decision" }, "user-ada");
		expect((await target.listMemories({ search: "deploys" })).memories).toHaveLength(2);

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

	// Cloudflare evicts an idle object, as the registry is while its conversations are copied: on
	// staging it restarted after half a minute, and the move failed when its freeze ended there.
	it("holds a freeze through a restart, until it lapses", async () => {
		const name = crypto.randomUUID();
		let registry = env.REGISTRY.getByName(name);
		await registry.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief.\n" });
		const token = crypto.randomUUID();
		expect(await registry.moveOut(token, "eu")).toMatchObject({ frozen: true });

		registry = await restart(registry);
		// The move reads on, and nothing writes behind its back.
		expect(
			(await registry.moveRead(token, { table: 0, after: null })).tables.length,
		).toBeGreaterThan(0);
		expect(
			await failure(
				registry.createLibraryAsset({ kind: "instructions", name: "late", text: "Late.\n" }),
			),
		).toContain(MOVING_MESSAGE);

		// A freeze whose move died lapses, and the next start ends it.
		await runInDurableObject(registry, (_instance: RegistryDO, state) => {
			const freeze = state.storage.kv.get<{ until: number }>("move.freeze");
			if (!freeze) throw new Error("Not frozen");
			state.storage.kv.put("move.freeze", { ...freeze, until: Date.now() - 1 });
		});
		registry = await restart(registry);
		await registry.createLibraryAsset({ kind: "instructions", name: "after", text: "Fine.\n" });
		expect(await failure(registry.moveRead(token, { table: 0, after: null }))).toBe(
			"The move was interrupted: the workspace is no longer frozen for it.",
		);
	});
});

type Registry = ReturnType<typeof env.REGISTRY.getByName>;

/** Starts the registry afresh, as an eviction does. Returns a stub of the new instance. */
async function restart(stub: Registry): Promise<Registry> {
	await runInDurableObject(stub, (_instance: RegistryDO, state) => state.abort("restart")).catch(
		() => {},
	);
	const fresh = env.REGISTRY.get(stub.id);
	await fresh.listProjects();
	return fresh;
}

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
