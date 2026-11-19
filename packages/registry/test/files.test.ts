import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	AGENT_ENGINES,
	type AgentDefinitionInput,
	agentDefinitionInput,
	ENGINE_NAMES,
	FILES_NEED_REPOSITORY,
	FILES_NOT_OFFERED,
	FILES_WITH_SANDBOX,
	MAX_SANDBOX_STEPS,
	MAX_WORKSPACE_SANDBOXES,
} from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";
import { saveAgent } from "./agent-update";

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

/** Calls the object directly, for calls expected to throw (see registry.test.ts). */
const inside = <T>(stub: ReturnType<typeof registry>, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

/** An agent as the forms that know nothing of `files` send it. */
function plain(fields: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
	return {
		name: "Builder",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		...fields,
	};
}

/** An agent set to work on a repository's files without a sandbox. */
const onFiles = (repositoryId: string | null, fields: Partial<AgentDefinitionInput> = {}) =>
	plain({ files: true, repositoryId, ...fields });

/**
 * Runs `fn` on a registry whose server has these settings besides the test Worker's, which binds
 * no sandbox and sets nothing for `files`.
 */
function withSettings<T>(
	stub: ReturnType<typeof registry>,
	added: Record<string, unknown>,
	fn: (instance: RegistryDO) => Promise<T>,
) {
	return runInDurableObject(stub, async (instance: RegistryDO) => {
		// `env` is protected, and a test of the server's settings is what needs it.
		const { env: settings } = instance as unknown as { env: Record<string, unknown> };
		Object.assign(settings, added);
		try {
			return await fn(instance);
		} finally {
			for (const name of Object.keys(added)) delete settings[name];
		}
	});
}

/** A server that lets `files` turns through and is a GitHub App; only their presence is read. */
const OFFERED = { FILES_ONLY_RUNS: "1", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused" };

/** The rows of `agent_definitions`, as SQLite holds them. */
function storedDefinitions(stub: ReturnType<typeof registry>) {
	return runInDurableObject(stub, (_instance, state) =>
		state.storage.sql.exec("SELECT * FROM agent_definitions ORDER BY agent_id").toArray(),
	);
}

/** A server that runs as a local command, as `.mcp.json` has one. */
const LOCAL = { command: "npx", args: ["-y", "@acme/mcp"] };

/**
 * A library copy of an MCP server a scan found in the repository's `.mcp.json`, stored as the
 * scan stores it: a new library asset called `name`, or with `into`, a new version of that one.
 */
async function scannedServer(
	stub: ReturnType<typeof registry>,
	repository: string,
	name: string,
	server: object,
	into?: string,
) {
	await stub.applyScan(repository, {
		commit: (into ? "b" : "a").repeat(40),
		scannedAt: into ? 2_000 : 1_000,
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
	return stub.addToLibrary(asset?.id ?? "", into ? { libraryAssetId: into } : { name });
}

describe("an agent that works on files without a sandbox", () => {
	it("is saved with a repository, and the definition, the snapshot and the row keep it", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(onFiles(site));

		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			files: true,
			sandbox: false,
			engine: "gateweave",
			repository: { id: site, owner: "acme", name: "site", removed: false },
		});
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({ files: true, sandbox: false });
		expect(await storedDefinitions(stub)).toMatchObject([
			{ agent_id: agent.id, files: 1, sandbox: 0, repository_id: site },
		]);

		// An edit that sends it again keeps it, and one that turns it off with its repository does.
		await saveAgent(stub, agent.id, onFiles(site, { name: "Fixer", memory: true }));
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			files: true,
			memory: true,
			repository: { id: site },
		});
		await saveAgent(stub, agent.id, plain());
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			files: false,
			sandbox: false,
			repository: null,
		});
		expect(await stub.agentSnapshot(agent.id)).not.toHaveProperty("files");

		// And it becomes an agent with a sandbox on the same repository, or one with files again.
		await saveAgent(stub, agent.id, plain({ sandbox: true, repositoryId: site }));
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			files: false,
			sandbox: true,
			repository: { id: site },
		});
		await saveAgent(stub, agent.id, onFiles(site));
		expect(await storedDefinitions(stub)).toMatchObject([{ files: 1, sandbox: 0 }]);
	});

	it("needs a repository, and has it or a sandbox, never both", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(plain());
		await inside(stub, (instance) => {
			for (const save of [
				(input: AgentDefinitionInput) => instance.createAgent(input),
				(input: AgentDefinitionInput) =>
					instance.updateAgent(agent.id, agentDefinitionInput.parse(input), agent.updatedAt),
			]) {
				expect(() => save(onFiles(null))).toThrow(FILES_NEED_REPOSITORY);
				expect(() => save(onFiles(null))).toThrow("Files only works on a repository: choose one");
				expect(() => save(onFiles(site, { sandbox: true }))).toThrow(FILES_WITH_SANDBOX);
				expect(() => save(onFiles(site, { sandbox: true }))).toThrow(
					"An agent works on files without a sandbox or has a sandbox, not both",
				);
				expect(() => save(onFiles(null, { sandbox: true }))).toThrow(FILES_WITH_SANDBOX);
				expect(() => save(onFiles("nope"))).toThrow("There is no such repository in the workspace");
			}
		});
		// Nothing was made or changed by a save that was refused.
		expect(await stub.listAgents()).toHaveLength(1);
		expect(await storedDefinitions(stub)).toMatchObject([
			{ agent_id: agent.id, files: 0, sandbox: 0, repository_id: null },
		]);
	});

	it("is refused a repository it sends without the setting, as before the setting existed", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(onFiles(site));
		// A client that knows nothing of the setting sends the repository alone: it is told why
		// that cannot be saved, in the words it always was, and the agent stays as it is.
		await inside(stub, (instance) => {
			expect(() =>
				instance.updateAgent(
					agent.id,
					agentDefinitionInput.parse(plain({ repositoryId: site })),
					agent.updatedAt,
				),
			).toThrow("Only an agent with a sandbox can have a repository: it is checked out there");
			expect(() => instance.createAgent(plain({ repositoryId: site }))).toThrow(
				"Only an agent with a sandbox can have a repository: it is checked out there",
			);
		});
		expect(await storedDefinitions(stub)).toMatchObject([{ files: 1, repository_id: site }]);
	});

	it("runs in Gateweave's own loop only", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		await inside(stub, (instance) => {
			for (const engine of AGENT_ENGINES) {
				if (engine === "gateweave") continue;
				expect(() => instance.createAgent(onFiles(site, { engine }))).toThrow(
					`${ENGINE_NAMES[engine]} runs in the agent's sandbox: turn the sandbox on`,
				);
			}
		});
		expect(await stub.listAgents()).toEqual([]);
	});

	it("cannot pin an MCP server that runs as a local command, as an agent without a sandbox cannot", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		const local = await scannedServer(stub, site, "local", LOCAL);
		const words =
			"local runs as a local command, which starts in the agent's sandbox: turn the sandbox on";
		await inside(stub, (instance) => {
			const mcpServers = [{ assetId: local, version: 1 }];
			expect(() => instance.createAgent(onFiles(site, { mcpServers }))).toThrow(words);
			expect(() => instance.createAgent(plain({ mcpServers }))).toThrow(words);
		});
		expect(await stub.listAgents()).toEqual([]);
	});

	it("keeps the file setup when an old page sends an incomplete save", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(onFiles(site));
		// What the app's form sent before it carried the file setup.
		const old = { ...plain({ name: "Renamed" }), sandbox: false, repositoryId: null };
		expect(old).not.toHaveProperty("files");
		await inside(stub, (instance) => {
			expect(() => {
				// @ts-expect-error Old clients can send creation-shaped updates over RPC.
				instance.updateAgent(agent.id, old, agent.updatedAt);
			}).toThrow();
		});
		expect((await stub.getAgent(agent.id))?.agent.name).toBe(agent.name);
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			files: true,
			sandbox: false,
		});
		expect(await storedDefinitions(stub)).toMatchObject([
			{ agent_id: agent.id, files: 1, sandbox: 0, repository_id: site },
		]);
	});

	it("is told a repository on GitLab cannot be worked on, in its own words and not a sandbox's", async () => {
		const stub = registry();
		const [shop = ""] = await stub.syncRepositories([
			{ ...SITE, provider: "gitlab", externalId: "gitlab.example.test:7", name: "shop" },
		]);
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(onFiles(shop))).toThrow(
				"acme/shop is on GitLab: an agent works on the files of GitHub repositories only, for now",
			);
			expect(() => instance.createAgent(onFiles(shop))).not.toThrow(/sandbox/);
			// An agent with a sandbox is told what it always was.
			expect(() => instance.createAgent(plain({ sandbox: true, repositoryId: shop }))).toThrow(
				"acme/shop is on GitLab: sandboxes check out GitHub repositories only, for now",
			);
		});
		expect(await stub.listAgents()).toEqual([]);
	});

	it("takes only a repository the workspace's GitHub App reaches, and keeps one it had", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(onFiles(site));
		await stub.removeInstallation("99");
		await expect(
			saveAgent(stub, agent.id, onFiles(site, { name: "Fixer" })),
		).resolves.toMatchObject({ name: "Fixer" });
		await inside(stub, (instance) => {
			expect(() => instance.createAgent(onFiles(site))).toThrow(
				"The workspace's GitHub App no longer reaches acme/site",
			);
		});
	});
});

describe("a turn of an agent that works on files without a sandbox", () => {
	async function conversation(stub: ReturnType<typeof registry>) {
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(onFiles(site));
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		return { agent, site, id };
	}

	const refusal = {
		status: "refused",
		message:
			"This server does not run agents on files without a sandbox yet, so Builder cannot answer.",
	};

	it("is refused unless the server says it runs them, and begins no run", async () => {
		const stub = registry();
		const { id } = await conversation(stub);
		expect(refusal.message).toBe(`${FILES_NOT_OFFERED}, so Builder cannot answer.`);
		expect(await stub.beginTurn(id, "Fix the typo")).toEqual(refusal);
		// Sandboxes and a GitHub App do not offer it: only the setting does, and only as `1`.
		const server = { SANDBOX: {}, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused" };
		// A number or a list that would read as `1` is not the text `1`.
		for (const value of [undefined, "", "0", "true", "yes", "11", 0, true, 1, ["1"]]) {
			await withSettings(stub, { ...server, FILES_ONLY_RUNS: value }, async (instance) => {
				expect(await instance.beginTurn(id, "Fix the typo")).toEqual(refusal);
			});
		}
		expect(await stub.listRuns()).toEqual([]);
	});

	it("goes on where the server runs them and no sandbox is offered, with the repository and its steps", async () => {
		const stub = registry();
		const { agent, id } = await conversation(stub);
		const turn = await withSettings(stub, OFFERED, (instance) =>
			instance.beginTurn(id, "Fix the typo"),
		);
		expect(turn).toEqual({
			agent: {
				agentId: agent.id,
				name: "Builder",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: null,
				sandbox: false,
				engine: "gateweave",
				memory: false,
				files: true,
				updatedAt: agent.updatedAt,
			},
			key: "sk-ant-api03-abcdefgh",
			mcpServers: [],
			edges: [],
			sandbox: false,
			repository: {
				owner: "acme",
				name: "site",
				externalId: "7",
				installationId: "99",
				defaultBranch: "main",
			},
			memory: false,
			files: true,
			steps: MAX_SANDBOX_STEPS,
			runId: expect.any(String),
		});
		expect(MAX_SANDBOX_STEPS).toBe(40);
		expect(JSON.stringify(turn)).not.toMatch(/token|ghs_/i);
		// Space around the setting is trimmed, as around the server's other settings.
		await withSettings(stub, { ...OFFERED, FILES_ONLY_RUNS: " 1\n" }, async (instance) => {
			expect(await instance.beginTurn(id, "And the next")).toMatchObject({ files: true });
		});
	});

	it("counts no sandbox time and passes no sandbox limit", async () => {
		const stub = registry();
		const { agent, id } = await conversation(stub);
		const others: string[] = [];
		for (let n = 0; n < MAX_WORKSPACE_SANDBOXES + 1; n++) {
			others.push((await stub.startConversation(agent.id, ADA))?.id ?? "");
		}
		// Limits that allow no sandbox time at all, and a list of invited workspaces this one is
		// not on: each refuses a turn with a sandbox.
		const closed = {
			...OFFERED,
			SANDBOX: {},
			SANDBOX_WORKSPACES: "another-workspace",
			SANDBOX_DAILY_MINUTES: "0",
			SANDBOX_MONTHLY_BUDGET: "0",
		};
		const runs = await withSettings(stub, closed, async (instance) => {
			const begun: string[] = [];
			// More conversations at once than the workspace may have sandboxes.
			for (const conversationId of [id, ...others]) {
				const turn = await instance.beginTurn(conversationId, "Fix the typo");
				if ("status" in turn) throw new Error(turn.message);
				expect(turn).toMatchObject({ sandbox: false, files: true });
				begun.push(turn.runId);
			}
			expect(instance.sandboxSecondsToday()).toBe(0);
			for (const runId of begun) {
				expect(
					instance.finishRun(runId, {
						status: "succeeded",
						error: null,
						steps: 3,
						inputTokens: 10,
						outputTokens: 5,
						cachedInputTokens: 0,
						cost: 1,
						endedAt: Date.now(),
					}),
				).toBe(true);
			}
			expect(instance.sandboxSecondsToday()).toBe(0);
			return begun;
		});
		expect(runs).toHaveLength(MAX_WORKSPACE_SANDBOXES + 2);
		for (const runId of runs) {
			expect(await stub.getRun(runId)).toMatchObject({ status: "succeeded", sandboxSeconds: null });
		}
		const stored = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql.exec("SELECT sandbox FROM runs").toArray(),
		);
		expect(stored).toEqual(runs.map(() => ({ sandbox: 0 })));
		expect(await stub.sandboxSecondsToday()).toBe(0);
	});

	it("is refused where the server cannot reach the repository, and is not told of a checkout", async () => {
		const stub = registry();
		const { id, site } = await conversation(stub);
		// A server that is not a GitHub App has no way to read it. Nothing is checked out here.
		await withSettings(stub, { FILES_ONLY_RUNS: "1" }, async (instance) => {
			expect(await instance.beginTurn(id, "Fix the typo")).toEqual({
				status: "refused",
				message:
					"GitHub is not set up on this server, so Builder cannot read acme/site. Whoever runs this server can set it up; see the README.",
			});
		});
		// An agent with a sandbox on the same repository is told what it always was.
		const builder = await stub.createAgent(
			plain({ name: "Coder", sandbox: true, repositoryId: site }),
		);
		const theirs = (await stub.startConversation(builder.id, ADA))?.id ?? "";
		await withSettings(stub, { SANDBOX: {} }, async (instance) => {
			expect(await instance.beginTurn(theirs, "Fix the build")).toEqual({
				status: "refused",
				message:
					"GitHub is not set up on this server, so Coder cannot check out acme/site. Whoever runs this server can set it up; see the README.",
			});
		});
		await stub.removeInstallation("99");
		await withSettings(stub, OFFERED, async (instance) => {
			expect(await instance.beginTurn(id, "Fix the typo")).toEqual({
				status: "refused",
				message:
					"The workspace's GitHub App no longer reaches acme/site, so Builder cannot answer. An owner or admin can choose another repository on the agent, or reconnect it in Repositories.",
			});
		});
		expect(await stub.listRuns()).toEqual([]);
	});

	it("is told in its own words when its repository turns out to be on GitLab", async () => {
		const stub = registry();
		const { id, site } = await conversation(stub);
		// No save allows it, so the row is changed where it lies: the turn reads it all the same.
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE repositories SET provider = 'gitlab' WHERE id = ?", site);
		});
		await withSettings(stub, OFFERED, async (instance) => {
			expect(await instance.beginTurn(id, "Fix the typo")).toEqual({
				status: "refused",
				message:
					"acme/site is on GitLab: an agent works on the files of GitHub repositories only, for now, so Builder cannot answer. An owner or admin can choose another repository on the agent, or reconnect it in Repositories.",
			});
		});
	});

	it("has no files on an ask, which has no tools, so an ask is not refused", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const [site = ""] = await stub.syncRepositories([SITE]);
		const planner = await stub.createAgent(plain({ name: "Planner" }));
		const fixer = await stub.createAgent(onFiles(site, { name: "Fixer" }));
		const team = (await stub.createTeam({ name: "Builders", description: null, lead: planner.id }))
			.id;
		await stub.setTeamGraph(team, {
			lead: planner.id,
			members: [planner, fixer].map(({ id }) => ({ kind: "agent" as const, id })),
			edges: [
				{ from: planner.id, to: fixer.id, kind: "ask" },
				{ from: planner.id, to: fixer.id, kind: "delegate" },
			],
		});
		const root = await stub.beginTurn(
			(await stub.startTeamConversation(team, ADA))?.id ?? "",
			"Plan the fix",
		);
		if ("status" in root) throw new Error(root.message);
		const via = (kind: "ask" | "delegate") => ({
			parentRunId: root.runId,
			parentSpanId: crypto.randomUUID(),
			kind,
			team,
			to: fixer.id,
		});
		const asked = await stub.beginTurn(crypto.randomUUID(), "How big is it?", via("ask"));
		expect(asked).toMatchObject({ agent: { name: "Fixer", files: true }, repository: null });
		expect(asked).not.toHaveProperty("files");
		expect(asked).not.toHaveProperty("steps");
		// A delegated turn has its tools, so it is the server's to offer.
		expect(await stub.beginTurn(crypto.randomUUID(), "Fix it", via("delegate"))).toEqual({
			status: "refused",
			message:
				"This server does not run agents on files without a sandbox yet, so Fixer cannot answer.",
		});
	});
});

describe("agents without the setting", () => {
	it("read byte for byte as they did before it existed, whatever the server says", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const agent = await stub.createAgent(plain());
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		// The snapshot and the turn as they were written before the setting, key for key in order.
		const snapshot = {
			agentId: agent.id,
			name: "Builder",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox: false,
			engine: "gateweave",
			memory: false,
			updatedAt: agent.updatedAt,
		};
		expect(JSON.stringify(await stub.agentSnapshot(agent.id))).toBe(JSON.stringify(snapshot));
		for (const settings of [{}, { FILES_ONLY_RUNS: "1" }]) {
			const turn = await withSettings(stub, settings, (instance) =>
				instance.beginTurn(id, "Hello"),
			);
			if ("status" in turn) throw new Error(turn.message);
			expect(JSON.stringify(turn)).toBe(
				JSON.stringify({
					agent: snapshot,
					key: "sk-ant-api03-abcdefgh",
					mcpServers: [],
					edges: [],
					sandbox: false,
					repository: null,
					memory: false,
					runId: turn.runId,
				}),
			);
		}
	});

	it("with a sandbox are refused where the server runs none, word for word, with no fallback to files", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(plain({ sandbox: true, repositoryId: site }));
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		await withSettings(stub, OFFERED, async (instance) => {
			expect(await instance.beginTurn(id, "Fix the build")).toEqual({
				status: "refused",
				message:
					"This server does not run sandboxes, so Builder cannot answer. Whoever runs this server can turn them on; see the README.",
			});
		});
		// And where it runs them, the turn has its sandbox and nothing of the other way.
		const turn = await withSettings(stub, { ...OFFERED, SANDBOX: {} }, (instance) =>
			instance.beginTurn(id, "Fix the build"),
		);
		expect(turn).toMatchObject({ sandbox: true, repository: { name: "site" } });
		expect(turn).not.toHaveProperty("files");
		expect(turn).not.toHaveProperty("steps");
	});
});

describe("moving a pin of an agent that works on files without a sandbox", () => {
	/** A files agent pinned to the first version of its instructions and of a remote MCP server. */
	async function pinned(stub: ReturnType<typeof registry>, fields: Partial<AgentDefinitionInput>) {
		const [site = ""] = await stub.syncRepositories([SITE]);
		const rules = await stub.createLibraryAsset({
			kind: "instructions",
			name: "Rules",
			text: "Be brief.\n",
		});
		const tracker = await scannedServer(stub, site, "tracker", {
			type: "http",
			url: "https://mcp.acme.dev/mcp",
		});
		const agent = await stub.createAgent(
			plain({
				repositoryId: site,
				instructions: { assetId: rules, version: 1 },
				mcpServers: [{ assetId: tracker, version: 1, tools: ["search"] }],
				memory: true,
				...fields,
			}),
		);
		const [file] = (await stub.getAsset(rules))?.version.files ?? [];
		await stub.editLibraryAsset({
			libraryAssetId: rules,
			files: [{ path: file?.path ?? "", content: "Be brief, and kind.\n" }],
		});
		// The server's second version runs as a local command, as a later scan found it changed.
		expect(await scannedServer(stub, site, "tracker", LOCAL, tracker)).toBe(tracker);
		expect((await stub.getAsset(tracker))?.asset.version).toBe(2);
		return { site, rules, tracker, agent };
	}

	it("keeps the setting and the repository, and is no turn for the server to refuse", async () => {
		const stub = registry();
		const { site, rules, agent } = await pinned(stub, { files: true });
		const rowsBefore = await storedDefinitions(stub);

		// The test Worker sets nothing for `files`, so a turn of this agent would be refused here.
		expect(await stub.moveAgentPin(agent.id, { assetId: rules, version: 2 })).toMatchObject({
			field: "instructions",
			from: 1,
			version: 2,
		});
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			files: true,
			sandbox: false,
			memory: true,
			instructions: { version: 2 },
			repository: { id: site },
			mcpServers: [{ version: 1, tools: ["search"] }],
		});
		expect(await stub.agentSnapshot(agent.id)).toMatchObject({
			files: true,
			instructions: "Be brief, and kind.\n",
		});
		expect(await storedDefinitions(stub)).toEqual(
			rowsBefore.map((row) => ({ ...row, instructions_version: 2 })),
		);
		expect(await stub.listRuns()).toEqual([]);
		// The move did not let a turn through either.
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		expect(await stub.beginTurn(id, "Fix the typo")).toEqual({
			status: "refused",
			message: `${FILES_NOT_OFFERED}, so Builder cannot answer.`,
		});
	});

	it("refuses a version that runs as a local command, as for an agent without a sandbox", async () => {
		const words =
			"tracker runs as a local command, which starts in the agent's sandbox: turn the sandbox on";
		for (const fields of [{ files: true }, { repositoryId: null }]) {
			const stub = registry();
			const { tracker, agent } = await pinned(stub, fields);
			const rowsBefore = await storedDefinitions(stub);
			await inside(stub, (instance) => {
				expect(() => instance.moveAgentPin(agent.id, { assetId: tracker, version: 2 })).toThrow(
					words,
				);
			});
			expect((await stub.getAgent(agent.id))?.definition?.mcpServers).toMatchObject([
				{ version: 1, tools: ["search"] },
			]);
			expect(await storedDefinitions(stub)).toEqual(rowsBefore);
		}
		// An agent with a sandbox can start it, so its pin moves.
		const stub = registry();
		const { tracker, agent } = await pinned(stub, { sandbox: true });
		expect(await stub.moveAgentPin(agent.id, { assetId: tracker, version: 2 })).toMatchObject({
			field: "mcpServers",
			version: 2,
		});
	});
});
