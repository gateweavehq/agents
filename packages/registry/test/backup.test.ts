import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { readRolledBack } from "../src/backup";

// Gateweave Backup reads a registry's SQLite through `backupRead`: the SELECTs of its dump, run
// together and rolled back, so a backup sees one moment and can never change the workspace.

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const ADA = "user-ada";

async function withConversation() {
	const stub = registry();
	const agent = await stub.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	const conversation = await stub.startConversation(agent.id, ADA);
	if (!conversation) throw new Error("The conversation did not start");
	return { stub, agent, conversation };
}

/** How a call inside the object failed: its error's message, or null if it didn't. */
async function failure(stub: ReturnType<typeof registry>, statements: unknown) {
	return runInDurableObject(stub, (instance) => {
		try {
			instance.backupRead(statements);
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
}

describe("reads for a backup", () => {
	it("return each statement's rows, as one moment", async () => {
		const { stub, agent } = await withConversation();
		const [schema, tables, agents, columns] = await stub.backupRead([
			"SELECT type, name FROM sqlite_master WHERE name = 'agents'",
			"PRAGMA table_list",
			"SELECT quote(id) || ',' || quote(name) AS v FROM agents",
			"PRAGMA table_info(agents)",
		]);
		expect(schema).toEqual([{ type: "table", name: "agents" }]);
		expect(tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "agents" })]));
		expect(agents).toEqual([{ v: `'${agent.id}','Reviewer'` }]);
		expect(columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: "name" })]));
	});

	it("refuse anything but a read, and more than one statement at a time", async () => {
		const { stub } = await withConversation();
		const refused = [
			["DELETE FROM agents"],
			["UPDATE agents SET name = 'x'"],
			["SELECT 1; DELETE FROM agents"],
			["PRAGMA foreign_keys = off"],
			["WITH t AS (SELECT 1) DELETE FROM agents"],
			[],
			"SELECT 1",
		];
		for (const statements of refused) {
			expect(await failure(stub, statements), JSON.stringify(statements)).toMatch(
				/^The object refused the backup's read\. /,
			);
		}
		const [agents] = await stub.backupRead(["SELECT name FROM agents"]);
		expect(agents).toEqual([{ name: "Reviewer" }]);
	});

	it("roll back whatever they ran, even a write that got past the check", async () => {
		const { stub } = await withConversation();
		const rows = await runInDurableObject(stub, (_, state) =>
			readRolledBack(state.storage, [
				"UPDATE agents SET name = 'Changed'",
				"SELECT name FROM agents",
			]),
		);
		// Inside the transaction the write showed; after it, it is gone.
		expect(rows[1]).toEqual([{ name: "Changed" }]);
		const [agents] = await stub.backupRead(["SELECT name FROM agents"]);
		expect(agents).toEqual([{ name: "Reviewer" }]);
	});
});

describe("a backup's list of conversations", () => {
	it("names every conversation, and knows which are in the index", async () => {
		const { stub, agent, conversation } = await withConversation();
		const second = await stub.startConversation(agent.id, "user-grace");
		if (!second) throw new Error("The conversation did not start");
		expect(await stub.backupConversations()).toEqual([conversation.id, second.id].sort());
		expect(await stub.backupHasConversation(conversation.id)).toBe(true);
		expect(await stub.backupHasConversation(crypto.randomUUID())).toBe(false);
		expect(await stub.backupHasConversation({ id: conversation.id })).toBe(false);
		expect(await registry().backupConversations()).toEqual([]);
	});
});
