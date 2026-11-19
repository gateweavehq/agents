import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentDefinitionInput } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/migrations.js";
import type { RegistryDO } from "../src";

/** The migration that adds `agent_definitions.outside_tasks` (AGT-155). */
const TAG = "0043_nifty_bulldozer";
const entry = migrations.journal.entries.find(({ tag }) => tag === TAG);
const newest = migrations.journal.entries.at(-1)?.tag;

type Stub = ReturnType<typeof registry>;
const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const ADA = "user-ada";

const SITE = {
	provider: "github" as const,
	externalId: "7",
	installationId: "99",
	owner: "acme",
	name: "site",
	defaultBranch: "main",
	private: true,
};

function agent(fields: Partial<AgentDefinitionInput>): AgentDefinitionInput {
	return {
		name: "Builder",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		...fields,
	};
}

/** Agents of every kind there was before the setting, and all the registry says of them. */
async function agentsBefore(stub: Stub) {
	await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
	const [site = ""] = await stub.syncRepositories([SITE]);
	const rules = await stub.createLibraryAsset({
		kind: "instructions",
		name: "rules",
		text: "Be brief.\n",
	});
	const made = [
		await stub.createAgent(agent({ name: "Plain" })),
		await stub.createAgent(
			agent({ name: "Reader", instructions: { assetId: rules, version: 1 }, memory: true }),
		),
		await stub.createAgent(agent({ name: "Builder", sandbox: true, repositoryId: site })),
		await stub.createAgent(agent({ name: "Coder", sandbox: true, engine: "claude-code" })),
	];
	const read = async (from: Stub) =>
		JSON.stringify({
			agents: await from.listAgents(),
			details: await Promise.all(made.map(({ id }) => from.getAgent(id))),
			snapshots: await Promise.all(made.map(({ id }) => from.agentSnapshot(id))),
		});
	return { made, read };
}

/** The rows of `agent_definitions`, as SQLite holds them. */
const stored = (stub: Stub) =>
	runInDurableObject(stub, (_instance, state) =>
		state.storage.sql.exec("SELECT * FROM agent_definitions ORDER BY agent_id").toArray(),
	);

/** The table as SQLite would make it again, and its columns as it reads them. */
const shape = (stub: Stub) =>
	runInDurableObject(stub, (_instance, state) => ({
		ddl: state.storage.sql
			.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'agent_definitions'")
			.one().sql,
		columns: state.storage.sql.exec("PRAGMA table_info(agent_definitions)").toArray(),
	}));

const columnNames = (state: DurableObjectState) =>
	state.storage.sql
		.exec<{ name: string }>("PRAGMA table_info(agent_definitions)")
		.toArray()
		.map(({ name }) => name);

/** Each agent still takes its turn, or is refused it, as before the setting. */
async function turnsAsBefore(stub: Stub, made: { id: string; name: string }[]) {
	const turn = async (agentId: string) => {
		const id = (await stub.startConversation(agentId, ADA))?.id ?? "";
		return stub.beginTurn(id, "Hello");
	};
	for (const one of made.slice(0, 2)) {
		const begun = await turn(one.id);
		expect(begun).toMatchObject({ sandbox: false, repository: null });
	}
	for (const one of made.slice(2)) {
		expect(await turn(one.id)).toEqual({
			status: "refused",
			message: `This server does not run sandboxes, so ${one.name} cannot answer. Whoever runs this server can turn them on; see the README.`,
		});
	}
}

/**
 * Starts the registry afresh, as a deploy does: its constructor migrates. Returns a stub of the
 * new instance.
 */
async function restart(stub: Stub): Promise<Stub> {
	await runInDurableObject(stub, (_instance: RegistryDO, state) => state.abort("restart")).catch(
		() => {},
	);
	const fresh = env.REGISTRY.get(stub.id);
	await fresh.listProjects();
	return fresh;
}

describe("the migration that adds an agent's outside-tasks setting", () => {
	/**
	 * Through the registry's own migrator, which decides by the journal's `when` and the newest row
	 * of `__drizzle_migrations` whether a migration runs at all: one whose `when` is not later than
	 * the migration before it is skipped on every registry that exists, and every read of an agent
	 * then fails for want of the column.
	 *
	 * It runs while this migration is the newest. A registry cannot be put back to before a later
	 * one from here, and by then this one has run everywhere and may not change; the order of the
	 * journal is held for every migration in `migrations.test.ts`.
	 */
	it.runIf(newest === TAG)(
		"runs when a registry on the schema before it wakes, and leaves every agent as it was",
		async () => {
			const stub = registry();
			const { made, read } = await agentsBefore(stub);
			const before = await read(stub);
			const rowsBefore = await stored(stub);

			// Back to what the migration before this one left: the table without the column, the
			// rows it held, and no note that this migration ran.
			await runInDurableObject(stub, (_instance, state) => {
				const { sql } = state.storage;
				sql.exec("ALTER TABLE agent_definitions DROP COLUMN outside_tasks");
				sql.exec("DELETE FROM __drizzle_migrations WHERE created_at = ?", entry?.when ?? 0);
				expect(columnNames(state)).not.toContain("outside_tasks");
				expect(sql.exec("SELECT count(*) AS n FROM __drizzle_migrations").one().n).toBe(
					migrations.journal.entries.length - 1,
				);
			});

			const woken = await restart(stub);
			expect(await read(woken)).toBe(before);
			const rows = await stored(woken);
			expect(rows).toEqual(rowsBefore);
			expect(rows).toHaveLength(made.length);
			// Off for every agent that existed before the setting, as the requirement asks.
			expect(rows.every((row) => row.outside_tasks === 0)).toBe(true);
			// The table is the one a registry made today has, to the letter.
			expect(await shape(woken)).toEqual(await shape(registry()));
			await runInDurableObject(woken, (_instance, state) => {
				expect(
					state.storage.sql.exec("SELECT count(*) AS n FROM __drizzle_migrations").one().n,
				).toBe(migrations.journal.entries.length);
			});
			await turnsAsBefore(woken, made);
		},
	);

	it("leaves every agent as it was when its statements run on the table before it", async () => {
		const stub = registry();
		const { made, read } = await agentsBefore(stub);
		const before = await read(stub);
		const rowsBefore = await stored(stub);

		const sql = migrations.migrations[`m${String(entry?.idx).padStart(4, "0")}`] ?? "";
		expect(sql).toContain("agent_definitions");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("ALTER TABLE agent_definitions DROP COLUMN outside_tasks");
			expect(columnNames(state)).not.toContain("outside_tasks");
			expect(columnNames(state)).toHaveLength(Object.keys(rowsBefore[0] ?? {}).length - 1);
			// The migration's own statements, whatever the journal says of when they run.
			for (const statement of sql.split("--> statement-breakpoint")) {
				state.storage.sql.exec(statement);
			}
			expect(columnNames(state).at(-1)).toBe("outside_tasks");
		});

		expect(await read(stub)).toBe(before);
		const rows = await stored(stub);
		expect(rows).toEqual(rowsBefore);
		expect(rows).toHaveLength(made.length);
		expect(rows.every((row) => row.outside_tasks === 0)).toBe(true);
		await turnsAsBefore(stub, made);
	});
});
