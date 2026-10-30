import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_WORKSPACE_SANDBOXES, SANDBOX_IDLE_MINUTES } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const ADA = "user-ada";
const GRACE = "user-grace";

async function withAgent(stub: ReturnType<typeof registry>) {
	return stub.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
}

describe("conversations", () => {
	it("belong to the member who started them", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const first = await stub.startConversation(agent.id, ADA);
		expect(first).toMatchObject({
			agentId: agent.id,
			agentName: "Reviewer",
			agentRemoved: false,
			title: null,
		});
		expect(first).not.toHaveProperty("startedBy");
		const id = first?.id ?? "";

		expect(await stub.getConversation(id, ADA)).toEqual(first);
		expect(await stub.getConversation(id, GRACE)).toBeNull();
		expect(await stub.listConversations(GRACE)).toEqual([]);
		expect(await stub.removeConversation(id, GRACE)).toEqual([]);
		expect(await stub.listConversations(ADA)).toEqual([first]);

		expect(await stub.removeConversation(id, ADA)).toEqual([id]);
		expect(await stub.getConversation(id, ADA)).toBeNull();
	});

	it("are only had with live agents run by Gateweave", async () => {
		const stub = registry();
		expect(await stub.startConversation("no-such-agent", ADA)).toBeNull();
		const agent = await withAgent(stub);
		await stub.removeAgent(agent.id);
		expect(await stub.startConversation(agent.id, ADA)).toBeNull();
	});

	it("list the latest first, titled after their first message", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const older = await stub.startConversation(agent.id, ADA);
		const newer = await stub.startConversation(agent.id, ADA);
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");

		await stub.beginTurn(older?.id ?? "", `  Review   this\n${"x".repeat(200)}`);
		await stub.beginTurn(older?.id ?? "", "A later message");
		const listed = await stub.listConversations(ADA);
		expect(listed.map((conversation) => conversation.id)).toEqual([older?.id, newer?.id]);
		const title = listed[0]?.title ?? "";
		expect(title.startsWith("Review this xxx")).toBe(true);
		expect(title.endsWith("…")).toBe(true);
		expect(Array.from(title)).toHaveLength(80);
		expect(listed[1]?.title).toBeNull();

		expect(await stub.listConversations(ADA, "another-agent")).toEqual([]);
		expect(await stub.listConversations(ADA, agent.id)).toHaveLength(2);
	});

	it("hand the runtime the agent and its key for each turn, or say why not", async () => {
		const stub = registry();
		const rules = await stub.createLibraryAsset({
			kind: "instructions",
			name: "review rules",
			text: "Review the change.\n",
		});
		const agent = await stub.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: { assetId: rules, version: 1 },
		});
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";

		expect(await stub.beginTurn(id, "Hello")).toEqual({
			status: "refused",
			message:
				"The workspace has no Anthropic key, so Reviewer cannot answer. An owner or admin can add one in Settings.",
		});
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		expect(await stub.beginTurn(id, "Hello")).toEqual({
			agent: {
				agentId: agent.id,
				name: "Reviewer",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: "Review the change.\n",
				sandbox: false,
				engine: "gateweave",
				updatedAt: agent.updatedAt,
			},
			key: "sk-ant-api03-abcdefgh",
			mcpServers: [],
			edges: [],
			sandbox: false,
			repository: null,
			runId: expect.any(String),
		});

		// A removed agent's conversations stay readable, and cannot go on.
		await stub.removeAgent(agent.id);
		expect((await stub.getConversation(id, ADA))?.agentRemoved).toBe(true);
		expect(await stub.beginTurn(id, "Hello")).toEqual({
			status: "refused",
			message: "This agent was removed, so the conversation cannot go on",
		});

		await stub.removeConversation(id, ADA);
		expect(await stub.beginTurn(id, "Hello")).toEqual({
			status: "refused",
			message: "This conversation was deleted",
		});
	});
});

describe("turns with Workers AI", () => {
	const TOKEN = "workers-ai-test-token-not-a-real-one";
	const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";

	async function workersAiConversation(stub: ReturnType<typeof registry>) {
		const agent = await stub.createAgent({
			name: "Scout",
			description: null,
			provider: "workers-ai",
			model: SCOUT,
			instructions: null,
		});
		return (await stub.startConversation(agent.id, ADA))?.id ?? "";
	}

	/** Runs `fn` on a registry whose server has not turned Workers AI on. */
	async function withoutToken<T>(
		stub: ReturnType<typeof registry>,
		fn: (instance: RegistryDO) => Promise<T>,
	) {
		return runInDurableObject(stub, async (instance: RegistryDO) => {
			// `env` is protected, and a test of the server's settings is what needs it.
			const { env: settings } = instance as unknown as {
				env: Record<string, string | undefined>;
			};
			const kept = settings.WORKERS_AI_TOKEN;
			delete settings.WORKERS_AI_TOKEN;
			try {
				return await fn(instance);
			} finally {
				settings.WORKERS_AI_TOKEN = kept;
			}
		});
	}

	it("begin without a key of the workspace's, and never carry the token", async () => {
		const stub = registry();
		const id = await workersAiConversation(stub);
		const turn = await stub.beginTurn(id, "Hello");
		expect(turn).toMatchObject({
			agent: { provider: "workers-ai", model: SCOUT },
			key: null,
			mcpServers: [],
			edges: [],
			runId: expect.any(String),
		});
		expect(JSON.stringify(turn)).not.toContain(TOKEN);
		expect(await stub.listProviderKeys()).toEqual([]);
	});

	it("are refused up front on a server that did not turn it on", async () => {
		const stub = registry();
		const id = await workersAiConversation(stub);
		const refusal = {
			status: "refused",
			message:
				"This server does not offer Workers AI, so Scout cannot answer. Whoever runs this server can turn it on; see the README.",
		};
		await withoutToken(stub, async (instance) => {
			expect(await instance.beginTurn(id, "Hello")).toEqual(refusal);
		});
		// The refusal is not the workspace's to fix: a key for another provider changes nothing.
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		await withoutToken(stub, async (instance) => {
			expect(await instance.beginTurn(id, "Hello")).toEqual(refusal);
		});
		expect(await stub.beginTurn(id, "Hello")).toMatchObject({ key: null });
	});
});

/**
 * Runs `fn` on a registry whose server binds sandboxes, which the test Worker does not, and
 * with `github`, is set up as a GitHub App too.
 */
async function withSandboxes<T>(
	stub: ReturnType<typeof registry>,
	fn: (instance: RegistryDO) => Promise<T>,
	{ github = false, invited }: { github?: boolean; invited?: string } = {},
) {
	return runInDurableObject(stub, async (instance: RegistryDO) => {
		// `env` is protected, and a test of the server's settings is what needs it.
		const { env: settings } = instance as unknown as { env: Record<string, unknown> };
		const added: Record<string, unknown> = { SANDBOX: {} };
		if (invited !== undefined) added.SANDBOX_WORKSPACES = invited;
		// Only their presence is read here: no test reaches GitHub.
		if (github) Object.assign(added, { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused" });
		Object.assign(settings, added);
		try {
			return await fn(instance);
		} finally {
			for (const name of Object.keys(added)) delete settings[name];
		}
	});
}

describe("turns with a sandbox", () => {
	async function builderConversation(stub: ReturnType<typeof registry>, sandbox: boolean) {
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const agent = await stub.createAgent({
			name: "Builder",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox,
		});
		return { agent, id: (await stub.startConversation(agent.id, ADA))?.id ?? "" };
	}

	it("are Claude Code's even when it is asked over a team's edge, since it runs only in one", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const agent = (name: string, more: object = {}) =>
			stub.createAgent({
				name,
				description: null,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: null,
				...more,
			});
		const planner = await agent("Planner");
		const coder = await agent("Coder", { sandbox: true, engine: "claude-code" });
		const team = (await stub.createTeam({ name: "Builders", description: null, lead: planner.id }))
			.id;
		await stub.setTeamGraph(team, {
			lead: planner.id,
			members: [
				{ kind: "agent", id: planner.id },
				{ kind: "agent", id: coder.id },
			],
			edges: [{ from: planner.id, to: coder.id, kind: "ask" }],
		});
		const conversation = (await stub.startTeamConversation(team, ADA))?.id ?? "";
		await withSandboxes(stub, async (instance) => {
			const root = await instance.beginTurn(conversation, "Plan the login page");
			if ("status" in root) throw new Error(root.message);
			const asked = await instance.beginTurn("nested-coder", "How big is the form?", {
				parentRunId: root.runId,
				parentSpanId: crypto.randomUUID(),
				kind: "ask",
				team,
				to: coder.id,
			});
			expect(asked).toMatchObject({
				agent: { name: "Coder", engine: "claude-code" },
				sandbox: true,
				edges: [],
			});
		});
	});

	it("are off unless the agent is given one, which its definition keeps", async () => {
		const stub = registry();
		const plain = await builderConversation(stub, false);
		expect(await stub.beginTurn(plain.id, "Hello")).toMatchObject({ sandbox: false });

		const { agent, id } = await builderConversation(stub, true);
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({ sandbox: true });
		await withSandboxes(stub, async (instance) => {
			expect(await instance.beginTurn(id, "Hello")).toMatchObject({
				agent: { name: "Builder", sandbox: true },
				sandbox: true,
			});
		});
	});

	it("carry the agent's engine, so Claude Code turns can tell theirs apart", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const agent = await stub.createAgent({
			name: "Builder",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox: true,
			engine: "claude-code",
		});
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		await withSandboxes(stub, async (instance) => {
			expect(await instance.beginTurn(id, "Hello")).toMatchObject({
				agent: { name: "Builder", engine: "claude-code" },
			});
		});
	});

	it("are refused up front on a server that runs no sandboxes", async () => {
		const stub = registry();
		const { id } = await builderConversation(stub, true);
		expect(await stub.beginTurn(id, "Hello")).toEqual({
			status: "refused",
			message:
				"This server does not run sandboxes, so Builder cannot answer. Whoever runs this server can turn them on; see the README.",
		});
		expect(await stub.listRuns()).toEqual([]);
	});

	it("are refused in a workspace the server has not invited, and go on in one it has", async () => {
		const workspace = crypto.randomUUID();
		const stub = env.REGISTRY.getByName(workspace);
		const { id } = await builderConversation(stub, true);
		await withSandboxes(
			stub,
			async (instance) => {
				expect(await instance.beginTurn(id, "Build it")).toEqual({
					status: "refused",
					message:
						"This server runs sandboxes only for the workspaces it invites, so Builder cannot answer. Whoever runs this server can invite this workspace.",
				});
			},
			{ invited: "another-workspace" },
		);
		expect(await stub.listRuns()).toEqual([]);
		await withSandboxes(
			stub,
			async (instance) => {
				expect(await instance.beginTurn(id, "Build it")).toMatchObject({ sandbox: true });
			},
			{ invited: `another-workspace, ${workspace}` },
		);
	});

	it("are refused once the workspace's sandboxes are all in use, until one is idle", async () => {
		const stub = registry();
		const { agent, id: first } = await builderConversation(stub, true);
		const others: string[] = [];
		for (let n = 1; n < MAX_WORKSPACE_SANDBOXES; n++) {
			others.push((await stub.startConversation(agent.id, ADA))?.id ?? "");
		}
		const last = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		await withSandboxes(stub, async (instance) => {
			for (const id of [first, ...others]) {
				expect(await instance.beginTurn(id, "Build it")).toMatchObject({ sandbox: true });
			}
			expect(await instance.beginTurn(last, "Build it")).toEqual({
				status: "refused",
				message: `The workspace's conversations are using all ${MAX_WORKSPACE_SANDBOXES} of its sandboxes, so Builder cannot answer now. A sandbox is free again ${SANDBOX_IDLE_MINUTES} minutes after its conversation's last turn.`,
			});
			// A conversation that has a sandbox goes on with it.
			expect(await instance.beginTurn(first, "And test it")).toMatchObject({ sandbox: true });
		});
		// Runs that ended longer ago than a sandbox stays up no longer hold one.
		await runInDurableObject(stub, (_instance, state) => {
			const ended = Date.now() - (SANDBOX_IDLE_MINUTES + 1) * 60_000;
			state.storage.sql.exec("UPDATE runs SET status = 'succeeded', ended_at = ?", ended);
		});
		await withSandboxes(stub, async (instance) => {
			expect(await instance.beginTurn(last, "Build it")).toMatchObject({ sandbox: true });
		});
	});
});

describe("turns with a repository", () => {
	const SITE = {
		provider: "github" as const,
		externalId: "7",
		installationId: "99",
		owner: "acme",
		name: "site",
		defaultBranch: "main",
		private: true,
	};

	function builder(repositoryId: string | null, sandbox = true) {
		return {
			name: "Builder",
			description: null,
			provider: "anthropic" as const,
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox,
			repositoryId,
		};
	}

	/** `withSandboxes` with a GitHub App as well. */
	function withServer<T>(
		stub: ReturnType<typeof registry>,
		fn: (instance: RegistryDO) => Promise<T>,
	) {
		return withSandboxes(stub, fn, { github: true });
	}

	it("are only for agents with a sandbox, and repositories the GitHub App reaches", async () => {
		const stub = registry();
		const [site = ""] = await stub.syncRepositories([SITE]);
		await runInDurableObject(stub, (instance: RegistryDO) => {
			expect(() => instance.createAgent(builder(site, false))).toThrow(
				"Only an agent with a sandbox can have a repository: it is checked out there",
			);
			expect(() => instance.createAgent(builder("nope"))).toThrow(
				"There is no such repository in the workspace",
			);
		});
		const agent = await stub.createAgent(builder(site));
		expect((await stub.getAgent(agent.id))?.definition?.repository).toEqual({
			id: site,
			owner: "acme",
			name: "site",
			removed: false,
		});
	});

	it("hand the runtime the repository to check out, and never a token", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(builder(site));
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";

		const turn = await withServer(stub, (instance) => instance.beginTurn(id, "Fix the build"));
		expect(turn).toMatchObject({
			sandbox: true,
			repository: {
				owner: "acme",
				name: "site",
				externalId: "7",
				installationId: "99",
				defaultBranch: "main",
			},
		});
		expect(JSON.stringify(turn)).not.toMatch(/token|ghs_/i);

		// A server that is not a GitHub App has no way to check it out.
		await withSandboxes(stub, async (instance) => {
			expect(await instance.beginTurn(id, "Fix the build")).toEqual({
				status: "refused",
				message:
					"GitHub is not set up on this server, so Builder cannot check out acme/site. Whoever runs this server can set it up; see the README.",
			});
		});
	});

	it("are refused once the GitHub App no longer reaches the repository, which stays chosen", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const [site = ""] = await stub.syncRepositories([SITE]);
		const agent = await stub.createAgent(builder(site));
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		await stub.removeInstallation("99");

		expect((await stub.getAgent(agent.id))?.definition?.repository).toMatchObject({
			removed: true,
		});
		expect(await withServer(stub, (instance) => instance.beginTurn(id, "Fix the build"))).toEqual({
			status: "refused",
			message:
				"The workspace's GitHub App no longer reaches acme/site, so Builder cannot answer. An owner or admin can choose another repository on the agent, or reconnect it in Repositories.",
		});
		// The agent keeps it through an edit, but no agent can choose it anew.
		await expect(
			stub.updateAgent(agent.id, { ...builder(site), name: "Fixer" }),
		).resolves.toMatchObject({ name: "Fixer" });
		await runInDurableObject(stub, (instance: RegistryDO) => {
			expect(() => instance.createAgent(builder(site))).toThrow(
				"The workspace's GitHub App no longer reaches acme/site",
			);
		});
	});
});
