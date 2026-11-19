import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";

afterEach(() => {
	vi.restoreAllMocks();
});

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

/** Calls the object directly, for calls expected to throw (see registry.test.ts). */
const inside = <T>(stub: ReturnType<typeof registry>, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

/**
 * An agent with nothing at its default, pinned to the first version of its instructions, its
 * environment set and an MCP server, each of which has a second version since.
 */
async function pinned(stub: ReturnType<typeof registry>) {
	const rules = await stub.createLibraryAsset({
		kind: "instructions",
		name: "Rules",
		text: "Be brief.\n",
	});
	const prod = await stub.createEnvSet({
		name: "prod",
		variables: { REGION: "eu" },
		secrets: [],
	});
	const acme = await stub.createMcpServer({
		name: "acme",
		transport: "http",
		url: "https://mcp.acme.dev/mcp",
		headers: [],
	});
	const agent = await stub.createAgent({
		name: "Coder",
		description: "Writes the code.",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: rules, version: 1 },
		environment: { assetId: prod, version: 1 },
		mcpServers: [{ assetId: acme, version: 1, tools: ["search"] }],
		sandbox: true,
		engine: "claude-code",
		memory: true,
	});
	const [file] = (await stub.getAsset(rules))?.version.files ?? [];
	await stub.editLibraryAsset({
		libraryAssetId: rules,
		files: [{ path: file?.path ?? "", content: "Be brief, and kind.\n" }],
	});
	await stub.editEnvSet({ assetId: prod, variables: { REGION: "us" }, secrets: [] });
	await stub.editMcpServer({
		assetId: acme,
		transport: "http",
		url: "https://mcp.acme.dev/v2",
		headers: [],
	});
	return { rules, prod, acme, agent };
}

/** The versions an agent's pins are at, and the rest of its definition. */
async function stateOf(stub: ReturnType<typeof registry>, agentId: string) {
	const detail = await stub.getAgent(agentId);
	if (!detail?.definition) throw new Error("No definition");
	const { instructions, environment, mcpServers, ...rest } = detail.definition;
	return {
		name: detail.agent.name,
		description: detail.agent.description,
		pins: {
			instructions: instructions?.version,
			environment: environment?.version,
			mcpServers: mcpServers.map((server) => ({ version: server.version, tools: server.tools })),
		},
		rest,
	};
}

describe("moving an agent's pin", () => {
	it("moves that pin and leaves the rest of the agent as it was", async () => {
		const stub = registry();
		const { rules, prod, acme, agent } = await pinned(stub);
		const before = await stateOf(stub, agent.id);
		expect(before.rest).toMatchObject({ sandbox: true, engine: "claude-code", memory: true });

		expect(await stub.moveAgentPin(agent.id, { assetId: rules, version: 2 })).toMatchObject({
			agent: { id: agent.id, name: "Coder", assetIds: expect.arrayContaining([rules, prod, acme]) },
			field: "instructions",
			asset: "Rules",
			from: 1,
			version: 2,
		});
		expect(await stateOf(stub, agent.id)).toEqual({
			...before,
			pins: { ...before.pins, instructions: 2 },
		});
		// A turn reads the version the pin moved to, with the engine and memory the agent had.
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({
			instructions: "Be brief, and kind.\n",
			sandbox: true,
			engine: "claude-code",
			memory: true,
		});

		expect(await stub.moveAgentPin(agent.id, { assetId: prod, version: 2 })).toMatchObject({
			field: "environment",
			asset: "prod",
			from: 1,
			version: 2,
		});
		// A server keeps the tools the agent was limited to.
		expect(await stub.moveAgentPin(agent.id, { assetId: acme, version: 2 })).toMatchObject({
			field: "mcpServers",
			asset: "acme",
			from: 1,
			version: 2,
		});
		expect(await stateOf(stub, agent.id)).toEqual({
			...before,
			pins: {
				instructions: 2,
				environment: 2,
				mcpServers: [{ version: 2, tools: ["search"] }],
			},
		});
		// The asset's page still lists the agent.
		expect((await stub.getAsset(rules))?.agents.map((reader) => reader.id)).toEqual([agent.id]);
	});

	it("moves the pin of that agent alone, and marks only that agent changed", async () => {
		const stub = registry();
		const { rules, prod, acme, agent } = await pinned(stub);
		// Another agent pins the same three assets, at the same versions.
		const other = await stub.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: { assetId: rules, version: 1 },
			environment: { assetId: prod, version: 1 },
			mcpServers: [{ assetId: acme, version: 1, tools: null }],
		});
		const others = await stateOf(stub, other.id);
		const later = agent.updatedAt + 60_000;
		vi.spyOn(Date, "now").mockReturnValue(later);

		for (const [index, assetId] of [rules, prod, acme].entries()) {
			const moved = await stub.moveAgentPin(agent.id, { assetId, version: 2 });
			expect(moved?.agent.updatedAt).toBe(later + index);
		}
		expect((await stateOf(stub, agent.id)).pins).toEqual({
			instructions: 2,
			environment: 2,
			mcpServers: [{ version: 2, tools: ["search"] }],
		});
		// A turn tells a changed agent by this.
		expect((await stub.agentSnapshot(agent.id))?.updatedAt).toBe(later + 2);
		expect((await stub.getAgent(agent.id))?.agent.updatedAt).toBe(later + 2);

		expect(await stateOf(stub, other.id)).toEqual(others);
		expect((await stub.agentSnapshot(other.id))?.updatedAt).toBe(other.updatedAt);
	});

	it("moves a pin back to an older version", async () => {
		const stub = registry();
		const { rules, agent } = await pinned(stub);
		await stub.moveAgentPin(agent.id, { assetId: rules, version: 2 });
		expect(await stub.moveAgentPin(agent.id, { assetId: rules, version: 1 })).toMatchObject({
			field: "instructions",
			from: 2,
			version: 1,
		});
		expect((await stateOf(stub, agent.id)).pins.instructions).toBe(1);
		expect((await stub.agentSnapshot(agent.id))?.instructions).toBe("Be brief.\n");
	});

	it("moves a pin whose asset has left the library, as an update lets it stay pinned", async () => {
		const stub = registry();
		const { rules, agent } = await pinned(stub);
		await stub.removeFromLibrary(rules);
		expect((await stub.getAgent(agent.id))?.definition?.instructions).toMatchObject({
			version: 1,
			removed: true,
		});
		expect(await stub.moveAgentPin(agent.id, { assetId: rules, version: 2 })).toMatchObject({
			field: "instructions",
			asset: "Rules",
			from: 1,
			version: 2,
		});
		expect((await stub.getAgent(agent.id))?.definition?.instructions).toMatchObject({
			version: 2,
			removed: true,
		});
	});

	it("refuses an asset the agent does not pin and a version that does not exist", async () => {
		const stub = registry();
		const { rules, agent } = await pinned(stub);
		const other = await stub.createLibraryAsset({
			kind: "instructions",
			name: "Other rules",
			text: "Be thorough.\n",
		});
		const before = await stateOf(stub, agent.id);
		await inside(stub, (instance) => {
			expect(() => instance.moveAgentPin(agent.id, { assetId: other, version: 1 })).toThrow(
				"The agent does not pin that asset",
			);
			expect(() => instance.moveAgentPin(agent.id, { assetId: rules, version: 9 })).toThrow(
				"Rules has no version 9",
			);
			expect(() => instance.moveAgentPin(agent.id, { assetId: rules, version: 0 })).toThrow();
		});
		expect(await stateOf(stub, agent.id)).toEqual(before);
	});

	it("answers null for an agent that is not there or was removed", async () => {
		const stub = registry();
		const { rules, agent } = await pinned(stub);
		expect(await stub.moveAgentPin("nobody", { assetId: rules, version: 2 })).toBeNull();
		await stub.removeAgent(agent.id);
		expect(await stub.moveAgentPin(agent.id, { assetId: rules, version: 2 })).toBeNull();
	});
});
