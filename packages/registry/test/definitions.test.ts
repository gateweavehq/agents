import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentDefinitionInput } from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

/** Calls the object directly, for calls expected to throw (see registry.test.ts). */
const inside = <T>(stub: ReturnType<typeof registry>, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

afterEach(() => {
	vi.restoreAllMocks();
});

function reviewer(
	instructions: AgentDefinitionInput["instructions"],
	fields: Partial<AgentDefinitionInput> = {},
): AgentDefinitionInput {
	return {
		name: "Reviewer",
		description: "  ",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions,
		...fields,
	};
}

describe("agents run by Gateweave", () => {
	it("pin their instructions, and a turn reads one version of them", async () => {
		const stub = registry();
		const rules = await stub.createLibraryAsset({
			kind: "instructions",
			name: "review rules",
			text: "Review the change.\n",
		});
		const agent = await stub.createAgent(reviewer({ assetId: rules, version: 1 }));
		expect(agent).toMatchObject({
			runtime: "gateweave",
			repositoryId: null,
			key: agent.id,
			name: "Reviewer",
			description: null,
			model: "claude-sonnet-5-5",
			assetIds: [rules],
		});
		expect(await stub.listAgents()).toEqual([agent]);
		// The library asset's page lists the agents that read it.
		expect((await stub.getAsset(rules))?.agents.map((reader) => reader.id)).toEqual([agent.id]);

		const detail = await stub.getAgent(agent.id);
		expect(detail).toMatchObject({
			repository: null,
			definition: {
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: { asset: { id: rules, version: 1 }, version: 1, removed: false },
			},
			instructions: [{ content: "Review the change.\n" }],
		});
		expect(await stub.agentSnapshot(agent.id)).toEqual({
			agentId: agent.id,
			name: "Reviewer",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: "Review the change.\n",
			sandbox: false,
			engine: "gateweave",
			updatedAt: agent.updatedAt,
		});

		// A new version in the library changes nothing until the pin moves.
		const [file] = (await stub.getAsset(rules))?.version.files ?? [];
		await stub.editLibraryAsset({
			libraryAssetId: rules,
			files: [{ path: file?.path ?? "", content: "Review the change twice.\n" }],
		});
		expect((await stub.getAgent(agent.id))?.definition?.instructions).toMatchObject({
			asset: { version: 2 },
			version: 1,
		});
		expect((await stub.agentSnapshot(agent.id))?.instructions).toBe("Review the change.\n");

		const moved = await stub.updateAgent(
			agent.id,
			reviewer({ assetId: rules, version: 2 }, { model: "claude-opus-5-5" }),
		);
		expect(moved).toMatchObject({ model: "claude-opus-5-5" });
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({
			model: "claude-opus-5-5",
			instructions: "Review the change twice.\n",
		});

		// Without instructions it reads nothing.
		await stub.updateAgent(agent.id, reviewer(null));
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({ instructions: null });
		expect((await stub.getAsset(rules))?.agents).toEqual([]);
	});

	it("take instructions only from a prompt or instructions in the library", async () => {
		const stub = registry();
		const skill = await stub.createLibraryAsset({
			kind: "skill",
			name: "review",
			text: "---\nname: review\ndescription: Reviews a change\n---\n\nReview it.\n",
		});
		const prompt = await stub.createLibraryAsset({ kind: "prompt", name: "fix", text: "Fix.\n" });
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(reviewer({ assetId: skill, version: 1 }))).toThrow(
				"review is not instructions or a prompt",
			);
			expect(() => instance.createAgent(reviewer({ assetId: "nope", version: 1 }))).toThrow(
				"That library asset does not exist",
			);
			expect(() => instance.createAgent(reviewer({ assetId: prompt, version: 9 }))).toThrow(
				"fix has no version 9",
			);
			expect(() =>
				instance.createAgent(reviewer({ assetId: prompt, version: 1 }, { model: "has spaces" })),
			).toThrow(/no spaces/);
		});
		expect(await stub.listAgents()).toEqual([]);

		// An asset that leaves the library keeps the pin it had, but cannot be pinned anew.
		const agent = await stub.createAgent(reviewer({ assetId: prompt, version: 1 }));
		await stub.removeFromLibrary(prompt);
		expect(
			await stub.updateAgent(
				agent.id,
				reviewer({ assetId: prompt, version: 1 }, { name: "Fixer" }),
			),
		).toMatchObject({ name: "Fixer" });
		expect((await stub.getAgent(agent.id))?.definition?.instructions).toMatchObject({
			removed: true,
		});
		expect((await stub.agentSnapshot(agent.id))?.instructions).toBe("Fix.\n");
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(reviewer({ assetId: prompt, version: 1 }))).toThrow(
				"fix is no longer in the library",
			);
		});
	});

	it("are gone once removed", async () => {
		const stub = registry();
		const agent = await stub.createAgent(reviewer(null));
		expect(await stub.removeAgent(agent.id)).toBe(true);
		expect(await stub.removeAgent(agent.id)).toBe(false);
		expect(await stub.listAgents()).toEqual([]);
		expect(await stub.getAgent(agent.id)).toBeNull();
		expect(await stub.agentSnapshot(agent.id)).toBeNull();
		expect(await stub.updateAgent(agent.id, reviewer(null))).toBeNull();
		expect(await stub.removeAgent(crypto.randomUUID())).toBe(false);
	});

	it("are listed for chat in one call, in name order, without the removed or the scanned", async () => {
		const stub = registry();
		const beta = await stub.createAgent(reviewer(null, { name: "Beta" }));
		const alpha = await stub.createAgent(
			reviewer(null, { name: "Alpha", description: "Reviews", model: "claude-opus-5-5" }),
		);
		const gone = await stub.createAgent(reviewer(null, { name: "Gone" }));
		expect(await stub.removeAgent(gone.id)).toBe(true);

		// An agent found in a repository runs on its own runtime, not Gateweave's.
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
			agents: [
				{
					runtime: "claude-code",
					key: "main",
					name: "Scanned",
					description: null,
					model: null,
					path: null,
					metadata: {},
					assets: [],
				},
			],
			assets: [],
			problems: [],
			files: [],
		});

		expect(await stub.listRunnableAgents()).toEqual([
			{
				id: alpha.id,
				name: "Alpha",
				description: "Reviews",
				provider: "anthropic",
				model: "claude-opus-5-5",
			},
			{
				id: beta.id,
				name: "Beta",
				description: null,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
			},
		]);
	});

	it("choose from the models the workspace's key can use", async () => {
		const stub = registry();
		expect(await stub.listModels("anthropic")).toEqual({
			status: "refused",
			message: "There is no key for Anthropic",
		});
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const requests: Headers[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requests.push(new Headers(init?.headers));
			return Response.json({
				data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }],
				has_more: false,
			});
		});
		expect(await stub.listModels("anthropic")).toEqual([
			{ id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		]);
		expect(requests[0]?.get("x-api-key")).toBe("sk-ant-api03-abcdefgh");

		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 401 }));
		expect(await stub.listModels("anthropic")).toEqual({
			status: "refused",
			message: "Anthropic refused the key",
		});
	});
});

describe("agents' engines", () => {
	const claude = (fields: Partial<AgentDefinitionInput> = {}) =>
		reviewer(null, { engine: "claude-code", sandbox: true, ...fields });

	it("are Gateweave's own loop unless chosen otherwise, and the choice is kept", async () => {
		const stub = registry();
		const plain = await stub.createAgent(reviewer(null));
		expect((await stub.getAgent(plain.id))?.definition).toMatchObject({ engine: "gateweave" });
		expect(await stub.agentSnapshot(plain.id)).toMatchObject({ engine: "gateweave" });

		const agent = await stub.createAgent(claude());
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			engine: "claude-code",
			sandbox: true,
		});
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({ engine: "claude-code" });

		// An update that does not name an engine keeps Gateweave's, as the rest of the definition.
		await stub.updateAgent(plain.id, reviewer(null, { model: "claude-opus-5-5" }));
		expect(await stub.agentSnapshot(plain.id)).toMatchObject({ engine: "gateweave" });
	});

	it("refuse Claude Code without a sandbox or an Anthropic model, on create", async () => {
		const stub = registry();
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(claude({ sandbox: false }))).toThrow(
				"Claude Code runs in the agent's sandbox: turn the sandbox on",
			);
			expect(() => instance.createAgent(claude({ provider: "openai", model: "gpt-5" }))).toThrow(
				"Claude Code calls Anthropic's models: choose one of them",
			);
		});
		expect(await stub.listAgents()).toEqual([]);
	});

	it("take Codex with the sandbox and an OpenAI model, and refuse it otherwise", async () => {
		const stub = registry();
		const codex = (fields: Partial<AgentDefinitionInput> = {}) =>
			reviewer(null, {
				engine: "codex",
				sandbox: true,
				provider: "openai",
				model: "gpt-5.5",
				...fields,
			});
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(codex({ sandbox: false }))).toThrow(
				"Codex runs in the agent's sandbox: turn the sandbox on",
			);
			expect(() =>
				instance.createAgent(codex({ provider: "anthropic", model: "claude-sonnet-5-5" })),
			).toThrow("Codex calls OpenAI's models: choose one of them");
		});
		expect(await stub.listAgents()).toEqual([]);

		const agent = await stub.createAgent(codex());
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({
			engine: "codex",
			provider: "openai",
			sandbox: true,
		});
	});

	it("take OpenCode with the sandbox and an Anthropic, OpenAI or Google model, and refuse it otherwise", async () => {
		const stub = registry();
		const opencode = (fields: Partial<AgentDefinitionInput> = {}) =>
			reviewer(null, { engine: "opencode", sandbox: true, ...fields });
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(opencode({ sandbox: false }))).toThrow(
				"OpenCode runs in the agent's sandbox: turn the sandbox on",
			);
			expect(() =>
				instance.createAgent(opencode({ provider: "workers-ai", model: "@cf/meta/llama" })),
			).toThrow("OpenCode calls Anthropic's, OpenAI's or Google's models: choose one of them");
		});
		expect(await stub.listAgents()).toEqual([]);

		const anthropic = await stub.createAgent(opencode());
		expect(await stub.agentSnapshot(anthropic.id)).toMatchObject({
			engine: "opencode",
			provider: "anthropic",
			sandbox: true,
		});
		const openai = await stub.createAgent(
			opencode({ name: "Second", provider: "openai", model: "gpt-5.5" }),
		);
		expect(await stub.agentSnapshot(openai.id)).toMatchObject({
			engine: "opencode",
			provider: "openai",
		});
		const google = await stub.createAgent(
			opencode({ name: "Third", provider: "google", model: "gemini-3-flash" }),
		);
		expect(await stub.agentSnapshot(google.id)).toMatchObject({
			engine: "opencode",
			provider: "google",
			sandbox: true,
		});
	});

	it("let Claude Code use the agent's MCP servers", async () => {
		const stub = registry();
		const acme = await stub.createMcpServer({
			name: "acme",
			transport: "http",
			url: "https://mcp.acme.dev/mcp",
			headers: [],
		});
		const agent = await stub.createAgent(
			claude({ mcpServers: [{ assetId: acme, version: 1, tools: null }] }),
		);
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			engine: "claude-code",
			mcpServers: [{ asset: expect.objectContaining({ id: acme }), version: 1 }],
		});
	});

	it("refuse the same on edit, and leave the agent as it was", async () => {
		const stub = registry();
		const agent = await stub.createAgent(reviewer(null));
		await inside(stub, (instance) => {
			expect(() => instance.updateAgent(agent.id, claude({ sandbox: false }))).toThrow(
				"Claude Code runs in the agent's sandbox: turn the sandbox on",
			);
			expect(() =>
				instance.updateAgent(agent.id, claude({ provider: "google", model: "gemini-3" })),
			).toThrow("Claude Code calls Anthropic's models: choose one of them");
		});
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			engine: "gateweave",
			sandbox: false,
		});

		const moved = await stub.updateAgent(agent.id, claude());
		expect(moved).toMatchObject({ model: "claude-sonnet-5-5" });
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({ engine: "claude-code" });
	});
});
