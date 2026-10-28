// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentDefinitionInput, McpServerInput } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

/** Calls the object directly, for calls expected to throw (see registry.test.ts). */
const inside = <T>(stub: ReturnType<typeof registry>, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

const ACME: McpServerInput = {
	name: "acme",
	transport: "http",
	url: "https://mcp.acme.dev/mcp",
	headers: [
		{ name: "X-Team", value: "${ACME_TEAM}" },
		{ name: "Authorization", value: "Bearer ${ACME_TOKEN}" },
	],
};

function reviewer(mcpServers: AgentDefinitionInput["mcpServers"]): AgentDefinitionInput {
	return {
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		mcpServers,
	};
}

/** A library copy of a server a scan found in `.mcp.json`, stored as the scan stored it. */
async function scannedServer(stub: ReturnType<typeof registry>, name: string, server: object) {
	const [repository = ""] = await stub.syncRepositories([
		{
			provider: "github",
			externalId: "1",
			installationId: "100",
			owner: "acme",
			name: "web",
			defaultBranch: "main",
			private: true,
		},
	]);
	await stub.applyScan(repository, {
		commit: "a".repeat(40),
		scannedAt: 1_000,
		agents: [],
		assets: [
			{
				kind: "mcp-server",
				key: `.mcp.json#${name}`,
				name,
				description: null,
				path: ".mcp.json",
				files: [{ path: ".mcp.json", content: `${JSON.stringify(server)}\n` }],
				metadata: {},
			},
		],
		problems: [],
		files: [],
	});
	const [asset] = (await stub.getRepository(repository))?.assets ?? [];
	return stub.addToLibrary(asset?.id ?? "", { name });
}

describe("MCP servers", () => {
	it("are written into the library in the shape a scan stores them in", async () => {
		const stub = registry();
		const id = await stub.createMcpServer(ACME);
		const detail = await stub.getAsset(id);
		expect(detail?.asset).toMatchObject({
			kind: "mcp-server",
			name: "acme",
			repositoryId: null,
			version: 1,
			metadata: {
				type: "http",
				url: "https://mcp.acme.dev/mcp",
				headers: ["Authorization", "X-Team"],
			},
		});
		expect(detail?.version.files).toMatchObject([
			{
				path: ".mcp.json",
				content: `{
  "headers": {
    "Authorization": "Bearer \${ACME_TOKEN}",
    "X-Team": "\${ACME_TEAM}"
  },
  "type": "http",
  "url": "https://mcp.acme.dev/mcp"
}
`,
			},
		]);

		await inside(stub, (instance) => {
			expect(() => instance.createMcpServer(ACME)).toThrow(
				"The library already has an MCP server named acme",
			);
			// Its text is edited only through its settings, which keep values out of it.
			expect(() =>
				instance.editLibraryAsset({
					libraryAssetId: id,
					files: [{ path: ".mcp.json", content: '{"url":"https://x.dev","headers":{"A":"b"}}' }],
				}),
			).toThrow("MCP servers are edited with their settings");
		});

		// The same settings make no version; new ones make the next.
		const { name: _, ...settings } = ACME;
		expect(await stub.editMcpServer({ assetId: id, ...settings })).toBe(1);
		expect(
			await stub.editMcpServer({
				assetId: id,
				transport: "sse",
				url: "https://mcp.acme.dev/sse",
				headers: [],
			}),
		).toBe(2);
		expect((await stub.getAsset(id))?.asset.metadata).toEqual({
			type: "sse",
			url: "https://mcp.acme.dev/sse",
		});
	});

	it("are pinned by agents, with the variables each needs from the agent's environment set", async () => {
		const stub = registry();
		const acme = await stub.createMcpServer(ACME);
		const prod = await stub.createEnvSet({
			name: "prod",
			variables: { ACME_TEAM: "platform" },
			secrets: ["ACME_TOKEN"],
		});
		const input = {
			...reviewer([{ assetId: acme, version: 1 }]),
			environment: { assetId: prod, version: 1 },
		};
		const agent = await stub.createAgent(input);
		expect(agent.assetIds.sort()).toEqual([acme, prod].sort());
		expect((await stub.getAgent(agent.id))?.definition?.mcpServers).toEqual([
			{
				asset: expect.objectContaining({ id: acme, name: "acme" }),
				version: 1,
				removed: false,
				connection: { transport: "http", url: "https://mcp.acme.dev/mcp" },
				// The secret is declared but has no value yet.
				variables: [
					{ name: "ACME_TEAM", state: "set" },
					{ name: "ACME_TOKEN", state: "missing" },
				],
			},
		]);
		// The server's page lists the agents that use it.
		expect((await stub.getAsset(acme))?.agents.map((reader) => reader.id)).toEqual([agent.id]);

		// A server that leaves the library stays pinned where it was, and cannot be pinned anew.
		await stub.removeFromLibrary(acme);
		expect(await stub.updateAgent(agent.id, input)).toMatchObject({ id: agent.id });
		expect((await stub.getAgent(agent.id))?.definition?.mcpServers[0]?.removed).toBe(true);
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(input)).toThrow("acme is no longer in the library");
		});

		// Unpinning takes it off the agent.
		await stub.updateAgent(agent.id, { ...input, mcpServers: [] });
		expect((await stub.getAgent(agent.id))?.definition?.mcpServers).toEqual([]);
		expect((await stub.getAgent(agent.id))?.agent.assetIds).toEqual([prod]);
	});

	it("reach each turn with their headers' values from the agent's environment set", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const acme = await stub.createMcpServer(ACME);
		const docs = await stub.createMcpServer({
			name: "docs",
			transport: "sse",
			url: "https://docs.acme.dev/sse",
			headers: [{ name: "Authorization", value: "${DOCS_TOKEN}" }],
		});
		const prod = await stub.createEnvSet({
			name: "prod",
			variables: { ACME_TEAM: "platform" },
			secrets: ["ACME_TOKEN", "DOCS_TOKEN"],
		});
		await stub.setEnvSecret({ assetId: prod, name: "ACME_TOKEN", value: "acme-secret" }, "Ada");
		const servers = [
			{ assetId: acme, version: 1 },
			{ assetId: docs, version: 1 },
		];
		const agent = await stub.createAgent({
			...reviewer(servers),
			environment: { assetId: prod, version: 1 },
		});
		const conversation = await stub.startConversation(agent.id, "user-ada");
		expect(await stub.beginTurn(conversation?.id ?? "", "Hello")).toMatchObject({
			mcpServers: [
				{
					name: "acme",
					transport: "http",
					url: "https://mcp.acme.dev/mcp",
					headers: { Authorization: "Bearer acme-secret", "X-Team": "platform" },
				},
				{ name: "docs", problem: "DOCS_TOKEN has no value in the agent's environment set" },
			],
		});

		// Without a set, every variable is missing.
		const bare = await stub.createAgent({ ...reviewer(servers), name: "Bare" });
		const started = await stub.startConversation(bare.id, "user-ada");
		expect(await stub.beginTurn(started?.id ?? "", "Hello")).toMatchObject({
			mcpServers: [
				{
					name: "acme",
					problem: "ACME_TEAM, ACME_TOKEN have no value in the agent's environment set",
				},
				{ name: "docs", problem: "DOCS_TOKEN has no value in the agent's environment set" },
			],
		});
	});

	it("cannot be pinned when an agent could not reach them", async () => {
		const stub = registry();
		const local = await scannedServer(stub, "local", { command: "npx", args: ["-y", "@acme/mcp"] });
		const plain = await scannedServer(stub, "plain", { type: "http", url: "http://mcp.acme.dev" });
		const rules = await stub.createLibraryAsset({
			kind: "instructions",
			name: "rules",
			text: "Be brief.\n",
		});
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(reviewer([{ assetId: local, version: 1 }]))).toThrow(
				"local: It runs as a local command, which agents run by Gateweave cannot start yet",
			);
			expect(() => instance.createAgent(reviewer([{ assetId: plain, version: 1 }]))).toThrow(
				"plain: The URL must start with https://",
			);
			expect(() => instance.createAgent(reviewer([{ assetId: rules, version: 1 }]))).toThrow(
				"rules is not an MCP server",
			);
		});
		expect(await stub.listAgents()).toEqual([]);
	});

	it("are checked with the environment set of an agent that pins them", async () => {
		const stub = registry();
		const acme = await stub.createMcpServer(ACME);
		const open = await stub.createMcpServer({
			name: "open",
			transport: "http",
			url: "https://open.acme.dev/mcp",
			headers: [],
		});
		const target = (assetId: string) => stub.mcpCheckTarget(assetId);

		// No agent pins it: the check has no environment, so a header's variable is missing.
		expect(await target(open)).toEqual({
			name: "open",
			transport: "http",
			url: "https://open.acme.dev/mcp",
			headers: {},
		});
		expect(await target(acme)).toEqual({
			name: "acme",
			problem: "ACME_TEAM, ACME_TOKEN have no value in the agent's environment set",
		});

		const sets = {
			old: await stub.createEnvSet({
				name: "old",
				variables: { ACME_TEAM: "legacy" },
				secrets: ["ACME_TOKEN"],
			}),
			current: await stub.createEnvSet({
				name: "current",
				variables: { ACME_TEAM: "platform" },
				secrets: ["ACME_TOKEN"],
			}),
		};
		await stub.setEnvSecret({ assetId: sets.old, name: "ACME_TOKEN", value: "old-token" }, "Ada");
		await stub.setEnvSecret(
			{ assetId: sets.current, name: "ACME_TOKEN", value: "current-token" },
			"Ada",
		);
		const pinned = (name: string, set: string, version: number) => ({
			...reviewer([{ assetId: acme, version }]),
			name,
			environment: { assetId: set, version: 1 },
		});
		await stub.createAgent(pinned("Aardvark", sets.old, 1));
		expect(await target(acme)).toMatchObject({
			headers: { Authorization: "Bearer old-token", "X-Team": "legacy" },
		});

		// A second version: the agent that pins the current one wins over one that sorts first.
		await stub.editMcpServer({
			assetId: acme,
			transport: "http",
			url: "https://mcp.acme.dev/v2",
			headers: ACME.headers,
		});
		await stub.createAgent(pinned("Zebra", sets.current, 2));
		expect(await target(acme)).toEqual({
			name: "acme",
			transport: "http",
			url: "https://mcp.acme.dev/v2",
			headers: { Authorization: "Bearer current-token", "X-Team": "platform" },
		});

		// Gone, removed or not an MCP server: nothing to check.
		const rules = await stub.createLibraryAsset({
			kind: "instructions",
			name: "rules",
			text: "Hi\n",
		});
		expect(await target(rules)).toBeNull();
		expect(await target("missing")).toBeNull();
		await stub.removeFromLibrary(open);
		expect(await target(open)).toBeNull();
	});

	it("keep the last check of each, and list on the MCP page with it", async () => {
		const stub = registry();
		const acme = await stub.createMcpServer(ACME);
		const local = await scannedServer(stub, "local", { command: "npx", args: ["-y", "@acme/mcp"] });
		const prod = await stub.createEnvSet({ name: "prod", variables: {}, secrets: [] });
		const agent = await stub.createAgent({
			...reviewer([{ assetId: acme, version: 1 }]),
			environment: { assetId: prod, version: 1 },
		});

		const before = await stub.listMcpServers();
		expect(before.map((entry) => entry.asset.name)).toEqual(["acme", "local"]);
		expect(before[0]).toMatchObject({
			connection: { transport: "http", url: "https://mcp.acme.dev/mcp" },
			variables: ["ACME_TEAM", "ACME_TOKEN"],
			agents: [{ id: agent.id, name: "Reviewer", version: 1 }],
			check: null,
		});
		expect(before[1]).toMatchObject({
			connection: { problem: expect.stringContaining("local command") },
			variables: [],
			agents: [],
		});

		const tools = [{ name: "search", description: "Searches the tracker" }];
		expect(await stub.recordMcpCheck(acme, { ok: true, tools })).toMatchObject({
			version: 1,
			ok: true,
			tools,
			error: null,
		});
		// A later check replaces the earlier one.
		const failed = await stub.recordMcpCheck(acme, { ok: false, error: "It could not be reached" });
		expect(failed).toMatchObject({ ok: false, tools: [], error: "It could not be reached" });
		expect((await stub.listMcpServers())[0]?.check).toEqual(failed);

		await inside(stub, (instance) => {
			expect(() =>
				instance.recordMcpCheck(acme, {
					ok: true,
					tools: [{ name: "x".repeat(300), description: "" }],
				}),
			).toThrow();
		});
		expect(await stub.recordMcpCheck("missing", { ok: true, tools: [] })).toBeNull();

		// An agent that is removed stops being listed as a user; a server that is removed, too.
		await stub.removeAgent(agent.id);
		expect((await stub.listMcpServers())[0]?.agents).toEqual([]);
		await stub.removeFromLibrary(acme);
		expect((await stub.listMcpServers()).map((entry) => entry.asset.name)).toEqual(["local"]);
		expect(await stub.recordMcpCheck(acme, { ok: true, tools: [] })).toBeNull();
	});
});
