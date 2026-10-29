import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { envSecretInput, envSetInput } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

/** Calls the object directly, for calls expected to throw (see registry.test.ts). */
const inside = <T>(stub: ReturnType<typeof registry>, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

const PASSWORD = "hunter2-correct-horse-battery";

async function newSet(stub: ReturnType<typeof registry>, name = "production") {
	return stub.createEnvSet({
		name,
		variables: { LOG_LEVEL: "info", REGION: "eu" },
		secrets: ["DATABASE_PASSWORD", "API_TOKEN"],
	});
}

function agent(environment: { assetId: string; version: number } | null) {
	return {
		name: "Runner",
		description: null,
		provider: "anthropic" as const,
		model: "claude-sonnet-5-5",
		instructions: null,
		environment,
	};
}

describe("environment input", () => {
	it("accepts names in capitals, and keeps a name to one role", () => {
		const base = { name: "set", variables: {}, secrets: [] };
		expect(envSetInput.safeParse({ ...base, variables: { A_1: "x", _B: "" } }).success).toBe(true);
		for (const bad of ["lower", "1ST", "WITH-DASH", "A B", ""]) {
			expect(envSetInput.safeParse({ ...base, variables: { [bad]: "x" } }).success).toBe(false);
			expect(envSetInput.safeParse({ ...base, secrets: [bad] }).success).toBe(false);
		}
		expect(envSetInput.safeParse({ ...base, variables: { A: "x" }, secrets: ["A"] }).success).toBe(
			false,
		);
		expect(envSetInput.safeParse({ ...base, secrets: ["A", "A"] }).success).toBe(false);
	});

	it("allows 200 entries in all, variables and secrets together", () => {
		const names = Array.from({ length: 201 }, (_, index) => `NAME_${index}`);
		const variables = Object.fromEntries(names.slice(0, 100).map((name) => [name, "x"]));
		const make = (secrets: string[]) => envSetInput.safeParse({ name: "s", variables, secrets });
		expect(make(names.slice(100, 200)).success).toBe(true);
		expect(make(names.slice(100, 201)).success).toBe(false);
	});

	it("drops one trailing newline from a secret's value and nothing else", () => {
		const parse = (value: string) =>
			envSecretInput.parse({ assetId: "a", name: "TOKEN", value }).value;
		expect(parse("abc\n")).toBe("abc");
		expect(parse("abc\r\n")).toBe("abc");
		expect(parse(" abc \n\n")).toBe(" abc \n");
		expect(envSecretInput.safeParse({ assetId: "a", name: "TOKEN", value: "\n" }).success).toBe(
			false,
		);
		expect(
			envSecretInput.safeParse({ assetId: "a", name: "TOKEN", value: "x".repeat(10_001) }).success,
		).toBe(false);
	});
});

describe("environment sets", () => {
	it("are library assets with one file, serialised the same way every time", async () => {
		const stub = registry();
		const id = await newSet(stub);
		const detail = await stub.getAsset(id);
		expect(detail?.asset).toMatchObject({ kind: "env-set", name: "production", version: 1 });
		expect(detail?.version.files).toHaveLength(1);
		expect(detail?.version.files[0]).toMatchObject({
			path: "environment.json",
			content:
				'{\n  "variables": {\n    "LOG_LEVEL": "info",\n    "REGION": "eu"\n  },\n  "secrets": [\n    "API_TOKEN",\n    "DATABASE_PASSWORD"\n  ]\n}\n',
		});

		await expect(
			inside(stub, (instance) =>
				instance.createEnvSet({ name: "production", variables: {}, secrets: [] }),
			),
		).rejects.toThrow("The library already has an environment set named production");
		await expect(
			inside(stub, (instance) =>
				instance.createEnvSet({ name: "bad", variables: { a: "x" }, secrets: [] }),
			),
		).rejects.toThrow();
	});

	it("get a new version only when an edit changes their content", async () => {
		const stub = registry();
		const id = await newSet(stub);
		// The same content in another order is the same file.
		expect(
			await stub.editEnvSet({
				assetId: id,
				variables: { REGION: "eu", LOG_LEVEL: "info" },
				secrets: ["API_TOKEN", "DATABASE_PASSWORD"],
			}),
		).toBe(1);
		expect(
			await stub.editEnvSet({
				assetId: id,
				variables: { REGION: "us", LOG_LEVEL: "info" },
				secrets: ["API_TOKEN", "DATABASE_PASSWORD"],
			}),
		).toBe(2);
		const entry = (await stub.listEnvSets())[0];
		expect(entry?.asset.version).toBe(2);
		expect(entry?.variables).toEqual({ LOG_LEVEL: "info", REGION: "us" });
		// Version 1 is kept.
		expect((await stub.getAsset(id, 1))?.version.files[0]?.content).toContain('"REGION": "eu"');
	});

	it("cannot be edited as plain files, which would bypass their rules", async () => {
		const stub = registry();
		const id = await newSet(stub);
		await expect(
			inside(stub, (instance) =>
				instance.editLibraryAsset({
					libraryAssetId: id,
					files: [{ path: "environment.json", content: '{"variables":{"a":"b"}}' }],
				}),
			),
		).rejects.toThrow("Environment sets are managed on the Environment page");
	});

	it("seal secret values, and report each name as set or missing", async () => {
		const stub = registry();
		const id = await newSet(stub);
		expect((await stub.listEnvSets())[0]?.secrets).toEqual([
			{ name: "API_TOKEN", state: "missing", setBy: null, setAt: null },
			{ name: "DATABASE_PASSWORD", state: "missing", setBy: null, setAt: null },
		]);

		const saved = await stub.setEnvSecret(
			{ assetId: id, name: "DATABASE_PASSWORD", value: `${PASSWORD}\n` },
			"Ada",
		);
		expect(saved).toMatchObject({ name: "DATABASE_PASSWORD", state: "set", setBy: "Ada" });
		const listed = await stub.listEnvSets();
		expect(listed[0]?.secrets).toEqual([
			{ name: "API_TOKEN", state: "missing", setBy: null, setAt: null },
			{ name: "DATABASE_PASSWORD", state: "set", setBy: "Ada", setAt: expect.any(Number) },
		]);
		// Nothing a page can read holds the value or any part of it.
		expect(JSON.stringify(listed)).not.toContain("hunter2");
		expect(JSON.stringify(await stub.getAsset(id))).not.toContain("hunter2");

		const rows = await runInDurableObject(stub, (_instance: RegistryDO, state) => ({
			secrets: state.storage.sql.exec("SELECT * FROM env_secrets").toArray(),
			blobs: state.storage.sql.exec("SELECT * FROM blobs").toArray(),
		}));
		expect(rows.secrets).toHaveLength(1);
		expect(rows.secrets[0]).toMatchObject({ asset_id: id, name: "DATABASE_PASSWORD" });
		expect(String(rows.secrets[0]?.sealed)).toMatch(/^v1\./);
		expect(JSON.stringify(rows)).not.toContain("hunter2");

		// A new value replaces the old one.
		await stub.setEnvSecret({ assetId: id, name: "DATABASE_PASSWORD", value: "second" }, "Grace");
		expect((await stub.listEnvSets())[0]?.secrets[1]).toMatchObject({ setBy: "Grace" });
		expect(await stub.removeEnvSecret(id, "DATABASE_PASSWORD")).toBe(true);
		expect(await stub.removeEnvSecret(id, "DATABASE_PASSWORD")).toBe(false);
		expect((await stub.listEnvSets())[0]?.secrets[1]?.state).toBe("missing");
	});

	it("refuse a value for a name that is not a secret of the current version", async () => {
		const stub = registry();
		const id = await newSet(stub);
		await expect(
			inside(stub, (instance) =>
				instance.setEnvSecret({ assetId: id, name: "LOG_LEVEL", value: "debug" }, "Ada"),
			),
		).rejects.toThrow("LOG_LEVEL is not a secret of production");
		await expect(
			inside(stub, (instance) =>
				instance.setEnvSecret({ assetId: id, name: "UNKNOWN", value: "x" }, "Ada"),
			),
		).rejects.toThrow("UNKNOWN is not a secret of production");
		await expect(
			inside(stub, (instance) =>
				instance.setEnvSecret({ assetId: "nope", name: "UNKNOWN", value: "x" }, "Ada"),
			),
		).rejects.toThrow("That environment set does not exist");
		expect((await stub.listEnvSets())[0]?.secrets.map((secret) => secret.state)).toEqual([
			"missing",
			"missing",
		]);
	});

	it("keep values for names that stop being secrets, reported as orphans until removed", async () => {
		const stub = registry();
		const id = await newSet(stub);
		await stub.setEnvSecret({ assetId: id, name: "API_TOKEN", value: "token-1" }, "Ada");
		await stub.editEnvSet({
			assetId: id,
			variables: { LOG_LEVEL: "info" },
			secrets: ["DATABASE_PASSWORD"],
		});
		const [entry] = await stub.listEnvSets();
		expect(entry?.secrets.map((secret) => secret.name)).toEqual(["DATABASE_PASSWORD"]);
		expect(entry?.orphans).toEqual([
			{ name: "API_TOKEN", setBy: "Ada", setAt: expect.any(Number) },
		]);

		// Moving the name back to the set finds the value again.
		await stub.editEnvSet({ assetId: id, variables: {}, secrets: ["API_TOKEN"] });
		expect((await stub.listEnvSets())[0]).toMatchObject({
			secrets: [{ name: "API_TOKEN", state: "set" }],
			orphans: [],
		});

		await stub.editEnvSet({ assetId: id, variables: {}, secrets: [] });
		expect(await stub.removeEnvSecret(id, "API_TOKEN")).toBe(true);
		expect((await stub.listEnvSets())[0]?.orphans).toEqual([]);
	});
});

describe("agents and environment sets", () => {
	it("pin a set like instructions, and the set lists its agents", async () => {
		const stub = registry();
		const id = await newSet(stub);
		const created = await stub.createAgent(agent({ assetId: id, version: 1 }));
		expect(created.assetIds).toEqual([id]);
		expect((await stub.getAgent(created.id))?.definition?.environment).toMatchObject({
			asset: { id, kind: "env-set", version: 1 },
			version: 1,
			removed: false,
		});
		expect((await stub.getAsset(id))?.agents.map((reader) => reader.id)).toEqual([created.id]);
		expect((await stub.listEnvSets())[0]?.agents).toEqual([
			{ id: created.id, name: "Runner", version: 1 },
		]);

		// A new version changes nothing until the pin moves; the snapshot's shape is unchanged.
		await stub.editEnvSet({ assetId: id, variables: { LOG_LEVEL: "debug" }, secrets: [] });
		expect((await stub.getAgent(created.id))?.definition?.environment).toMatchObject({
			asset: { version: 2 },
			version: 1,
		});
		expect(Object.keys((await stub.agentSnapshot(created.id)) ?? {}).sort()).toEqual([
			"agentId",
			"instructions",
			"model",
			"name",
			"provider",
			"sandbox",
			"updatedAt",
		]);

		await stub.updateAgent(created.id, agent({ assetId: id, version: 2 }));
		expect((await stub.listEnvSets())[0]?.agents[0]?.version).toBe(2);
		await stub.updateAgent(created.id, agent(null));
		expect((await stub.getAgent(created.id))?.definition?.environment).toBeNull();
		expect((await stub.getAgent(created.id))?.agent.assetIds).toEqual([]);
		expect((await stub.listEnvSets())[0]?.agents).toEqual([]);
	});

	it("pin only environment sets, in versions that exist", async () => {
		const stub = registry();
		const id = await newSet(stub);
		const rules = await stub.createLibraryAsset({
			kind: "instructions",
			name: "rules",
			text: "Be brief.\n",
		});
		const make = (environment: { assetId: string; version: number }) =>
			inside(stub, (instance) => instance.createAgent(agent(environment)));
		await expect(make({ assetId: rules, version: 1 })).rejects.toThrow(
			"rules is not an environment set",
		);
		await expect(make({ assetId: id, version: 9 })).rejects.toThrow("production has no version 9");
		await expect(make({ assetId: "nope", version: 1 })).rejects.toThrow(
			"That library asset does not exist",
		);
		// Instructions cannot be an environment set either.
		await expect(
			inside(stub, (instance) =>
				instance.createAgent({ ...agent(null), instructions: { assetId: id, version: 1 } }),
			),
		).rejects.toThrow("production is not instructions or a prompt");
		expect(await stub.listAgents()).toEqual([]);
	});

	it("keep a set that left the library, but cannot pin it anew", async () => {
		const stub = registry();
		const id = await newSet(stub);
		const pinned = await stub.createAgent(agent({ assetId: id, version: 1 }));
		await stub.removeFromLibrary(id);
		expect((await stub.getAgent(pinned.id))?.definition?.environment).toMatchObject({
			removed: true,
			version: 1,
		});
		// Saving the agent again keeps the pin.
		await stub.updateAgent(pinned.id, {
			...agent({ assetId: id, version: 1 }),
			name: "Renamed",
		});
		await expect(
			inside(stub, (instance) => instance.createAgent(agent({ assetId: id, version: 1 }))),
		).rejects.toThrow("production is no longer in the library");
		await expect(
			inside(stub, (instance) =>
				instance.setEnvSecret({ assetId: id, name: "API_TOKEN", value: "x" }, "Ada"),
			),
		).rejects.toThrow("production is no longer in the library");
	});

	it("resolve to the pinned version's variables, opened secrets and missing names", async () => {
		const stub = registry();
		const id = await newSet(stub);
		const created = await stub.createAgent(agent({ assetId: id, version: 1 }));
		await stub.setEnvSecret({ assetId: id, name: "DATABASE_PASSWORD", value: PASSWORD }, "Ada");

		expect(await stub.resolveEnvironment(created.id)).toEqual({
			values: { LOG_LEVEL: "info", REGION: "eu", DATABASE_PASSWORD: PASSWORD },
			missing: ["API_TOKEN"],
		});

		// Version 2 is not what the agent runs until its pin moves; its values still apply.
		await stub.editEnvSet({
			assetId: id,
			variables: { LOG_LEVEL: "debug" },
			secrets: ["API_TOKEN", "NEW_SECRET"],
		});
		expect((await stub.resolveEnvironment(created.id))?.values.LOG_LEVEL).toBe("info");
		await stub.updateAgent(created.id, agent({ assetId: id, version: 2 }));
		expect(await stub.resolveEnvironment(created.id)).toEqual({
			values: { LOG_LEVEL: "debug" },
			missing: ["API_TOKEN", "NEW_SECRET"],
		});

		// An agent without a set, a removed agent and an unknown one.
		const bare = await stub.createAgent(agent(null));
		expect(await stub.resolveEnvironment(bare.id)).toEqual({ values: {}, missing: [] });
		await stub.removeAgent(bare.id);
		expect(await stub.resolveEnvironment(bare.id)).toBeNull();
		expect(await stub.resolveEnvironment("nobody")).toBeNull();
	});

	it("treat a value that cannot be opened as missing", async () => {
		const stub = registry();
		const id = await newSet(stub);
		const created = await stub.createAgent(agent({ assetId: id, version: 1 }));
		await stub.setEnvSecret({ assetId: id, name: "API_TOKEN", value: "token" }, "Ada");
		// A sealed value copied to another name does not open there.
		await runInDurableObject(stub, (_instance: RegistryDO, state) => {
			state.storage.sql.exec(
				"UPDATE env_secrets SET name = 'DATABASE_PASSWORD' WHERE name = 'API_TOKEN'",
			);
		});
		expect(await stub.resolveEnvironment(created.id)).toEqual({
			values: { LOG_LEVEL: "info", REGION: "eu" },
			missing: ["API_TOKEN", "DATABASE_PASSWORD"],
		});
	});
});
