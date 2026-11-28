import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	MAX_WORKSPACE_SANDBOXES,
	requestCost,
	SANDBOX_BUDGET_SPENT,
	SANDBOX_DAY_USED,
	SANDBOX_IDLE_MINUTES,
	SANDBOX_MONTH_USED,
	SANDBOX_SECOND_PRICE,
} from "@gateweave/agents-model";
import { describe, expect, it, vi } from "vitest";
import { METER_NAME, type RegistryDO } from "../src";
import { saveAgent } from "./agent-update";
import type { RegistryDO as TestRegistry } from "./worker";

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
				memory: false,
				updatedAt: agent.updatedAt,
			},
			key: "sk-ant-api03-abcdefgh",
			mcpServers: [],
			edges: [],
			sandbox: false,
			repository: null,
			memory: false,
			runId: expect.any(String),
			origin: "person",
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

	/** Runs `fn` on a registry whose server set these Workers AI settings. */
	async function withSettings<T>(
		stub: ReturnType<typeof registry>,
		added: Record<string, string>,
		fn: (instance: RegistryDO) => Promise<T>,
	) {
		return runInDurableObject(stub, async (instance: RegistryDO) => {
			const { env: settings } = instance as unknown as { env: Record<string, unknown> };
			Object.assign(settings, added);
			try {
				return await fn(instance);
			} finally {
				for (const name of Object.keys(added)) delete settings[name];
			}
		});
	}

	it("are only for the workspaces the server invites", async () => {
		const workspace = crypto.randomUUID();
		const stub = env.REGISTRY.getByName(workspace);
		const id = await workersAiConversation(stub);
		const refused = {
			status: "refused",
			message:
				"This server offers Workers AI only to the workspaces it invites, so Scout cannot answer.",
		};
		await withSettings(stub, { WORKERS_AI_WORKSPACES: "someone-else" }, async (instance) => {
			expect(await instance.beginTurn(id, "Hello")).toEqual(refused);
		});
		await withSettings(stub, { WORKERS_AI_WORKSPACES: `other, ${workspace}` }, async (instance) => {
			expect(await instance.beginTurn(id, "Hello")).toHaveProperty("runId");
		});
		// `sandbox` invites the sandbox's invitations, and nobody when there are none.
		await withSettings(
			stub,
			{ WORKERS_AI_WORKSPACES: "sandbox", SANDBOX_WORKSPACES: workspace },
			async (instance) => {
				expect(await instance.beginTurn(id, "Hello")).toHaveProperty("runId");
			},
		);
		await withSettings(stub, { WORKERS_AI_WORKSPACES: "sandbox" }, async (instance) => {
			expect(await instance.beginTurn(id, "Hello")).toEqual(refused);
		});
	});

	it("stop for the day once the workspace spent its daily limit", async () => {
		const stub = registry();
		const id = await workersAiConversation(stub);
		const first = await stub.beginTurn(id, "Hello");
		if ("status" in first) throw new Error(first.message);
		// $1.50 at list prices.
		await stub.finishRun(first.runId, {
			status: "succeeded",
			error: null,
			steps: 1,
			inputTokens: 10,
			outputTokens: 5,
			cachedInputTokens: 0,
			cost: 1_500_000,
			endedAt: Date.now(),
		});
		expect(await stub.workersAiSpentToday()).toBeCloseTo(1.5, 6);
		await withSettings(stub, { WORKERS_AI_DAILY_DOLLARS: "2" }, async (instance) => {
			expect(await instance.beginTurn(id, "Again")).toHaveProperty("runId");
		});
		await withSettings(stub, { WORKERS_AI_DAILY_DOLLARS: "1.5" }, async (instance) => {
			expect(await instance.beginTurn(id, "Again")).toEqual({
				status: "refused",
				message:
					"This workspace has used its Workers AI for today, $1.5, so Scout cannot answer until the day ends (UTC). Another provider's model, with the workspace's own key, can answer meanwhile.",
			});
		});
		// A limit that is not a number allows nothing.
		await withSettings(stub, { WORKERS_AI_DAILY_DOLLARS: "twenty" }, async (instance) => {
			expect(await instance.beginTurn(id, "Again")).toHaveProperty("status", "refused");
		});
	});

	it("refuse a model with no prices only where a daily limit applies", async () => {
		const UNPRICED = "@cf/example/unpriced-model";
		const stub = registry();
		const agent = await stub.createAgent({
			name: "Ghost",
			description: null,
			provider: "workers-ai",
			model: UNPRICED,
			instructions: null,
		});
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		// Its cost would be null and never count, so under a limit it cannot start.
		await withSettings(stub, { WORKERS_AI_DAILY_DOLLARS: "20" }, async (instance) => {
			const turn = await instance.beginTurn(id, "Hello");
			expect(turn).toHaveProperty("status", "refused");
			expect(JSON.stringify(turn)).toContain(UNPRICED);
		});
		// With no limit, it runs as before.
		expect(await stub.beginTurn(id, "Hello")).toHaveProperty("runId");
	});

	// Cloudflare removes Kimi K2.6 on 2026-11-20. Until then it answers and the deployment pays, so
	// a run on it must have a cost: the day's sum skips a run without one, and the limit with it.
	it("count a run on a model Cloudflare is removing, until its day, toward the daily limit", async () => {
		const KIMI = "@cf/moonshotai/kimi-k2.6";
		const stub = registry();
		const agent = await stub.createAgent({
			name: "Coder",
			description: null,
			provider: "workers-ai",
			model: KIMI,
			instructions: null,
		});
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";
		const first = await stub.beginTurn(id, "Hello");
		if ("status" in first) throw new Error(first.message);
		// What the runtime records for a request of 400,000 tokens in and 30,000 out on 19 November.
		const tokens = { input: 400_000, output: 30_000, cacheRead: 0, cacheWrite: 0 };
		const cost = requestCost("workers-ai", KIMI, tokens, Date.parse("2026-11-19T12:00:00Z"));
		expect(cost).toBe(500_000);
		await stub.finishRun(first.runId, {
			status: "succeeded",
			error: null,
			steps: 1,
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			cachedInputTokens: 0,
			cost,
			endedAt: Date.now(),
		});
		expect(await stub.workersAiSpentToday()).toBeCloseTo(0.5, 6);
		await withSettings(stub, { WORKERS_AI_DAILY_DOLLARS: "0.5" }, async (instance) => {
			expect(await instance.beginTurn(id, "Again")).toHaveProperty("status", "refused");
		});
		// From the day it is gone, a request would fail and nothing is priced.
		expect(requestCost("workers-ai", KIMI, tokens, Date.parse("2026-11-20T00:00:00Z"))).toBeNull();
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
	{
		github = false,
		invited,
		limits = {},
	}: { github?: boolean; invited?: string; limits?: Record<string, string> } = {},
) {
	return runInDurableObject(stub, async (instance: RegistryDO) => {
		// `env` is protected, and a test of the server's settings is what needs it.
		const { env: settings } = instance as unknown as { env: Record<string, unknown> };
		const added: Record<string, unknown> = { SANDBOX: {}, ...limits };
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

	it("have the memory tools only in Gateweave's own loop, and never on an ask", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const agent = (name: string, more: object = {}) =>
			stub.createAgent({
				name,
				description: null,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: null,
				memory: true,
				...more,
			});
		const planner = await agent("Planner");
		const helper = await agent("Helper");
		const worker = await agent("Worker");
		const team = (await stub.createTeam({ name: "Builders", description: null, lead: planner.id }))
			.id;
		await stub.setTeamGraph(team, {
			lead: planner.id,
			members: [planner, helper, worker].map(({ id }) => ({ kind: "agent" as const, id })),
			edges: [
				{ from: planner.id, to: helper.id, kind: "ask" },
				{ from: planner.id, to: worker.id, kind: "delegate" },
			],
		});
		const conversation = (await stub.startTeamConversation(team, ADA))?.id ?? "";
		const root = await stub.beginTurn(conversation, "Plan the login page");
		if ("status" in root) throw new Error(root.message);
		expect(root.memory).toBe(true);
		const via = (kind: "ask" | "delegate", to: string) => ({
			parentRunId: root.runId,
			parentSpanId: crypto.randomUUID(),
			kind,
			team,
			to,
		});
		// A delegated turn has its tools. An ask is one model request without any.
		expect(
			await stub.beginTurn(crypto.randomUUID(), "Build the form", via("delegate", worker.id)),
		).toMatchObject({ agent: { name: "Worker", memory: true }, memory: true });
		expect(
			await stub.beginTurn(crypto.randomUUID(), "How big is it?", via("ask", helper.id)),
		).toMatchObject({ agent: { name: "Helper", memory: true }, memory: false });

		// An engine in the sandbox brings its own tools, and these are not among them yet.
		const builder = await agent("Builder", { sandbox: true, engine: "claude-code" });
		const theirs = (await stub.startConversation(builder.id, ADA))?.id ?? "";
		await withSandboxes(stub, async (instance) => {
			expect(await instance.beginTurn(theirs, "Hello")).toMatchObject({
				agent: { name: "Builder", engine: "claude-code", memory: true },
				memory: false,
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

	it("start no more than the workspace's sandboxes when turns begin at once", async () => {
		const stub = registry();
		const { agent, id: first } = await builderConversation(stub, true);
		const ids = [first];
		for (let n = 0; n < MAX_WORKSPACE_SANDBOXES + 2; n++) {
			ids.push((await stub.startConversation(agent.id, ADA))?.id ?? "");
		}
		const begun = await withSandboxes(stub, (instance) =>
			// Each checks the limit before it awaits the key, while no other has its run yet.
			Promise.all(ids.map((id) => instance.beginTurn(id, "Build it"))),
		);
		const started = begun.filter((turn) => !("status" in turn));
		expect(started).toHaveLength(MAX_WORKSPACE_SANDBOXES);
		expect(begun.filter((turn) => "status" in turn)).toEqual(
			Array(ids.length - MAX_WORKSPACE_SANDBOXES).fill({
				status: "refused",
				message: `The workspace's conversations are using all ${MAX_WORKSPACE_SANDBOXES} of its sandboxes, so Builder cannot answer now. A sandbox is free again ${SANDBOX_IDLE_MINUTES} minutes after its conversation's last turn.`,
			}),
		);
		const listed = await stub.listRuns();
		expect(listed).toHaveLength(ids.length);
		expect(listed.filter((run) => run.status === "running")).toHaveLength(MAX_WORKSPACE_SANDBOXES);
		expect(listed.filter((run) => run.status === "refused")).toHaveLength(
			ids.length - MAX_WORKSPACE_SANDBOXES,
		);
	});
});

describe("sandbox time", () => {
	const MINUTE = 60_000;
	const IDLE = SANDBOX_IDLE_MINUTES;
	const done = {
		status: "succeeded",
		error: null,
		steps: 1,
		inputTokens: 10,
		outputTokens: 5,
		cachedInputTokens: 0,
		cost: 1,
	} as const;

	async function builderConversations(stub: ReturnType<typeof registry>, count: number) {
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const agent = await stub.createAgent({
			name: "Builder",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox: true,
		});
		const ids: string[] = [];
		for (let n = 0; n < count; n++)
			ids.push((await stub.startConversation(agent.id, ADA))?.id ?? "");
		return ids;
	}

	async function turn(instance: RegistryDO, conversation: string) {
		const begun = await instance.beginTurn(conversation, "Build it");
		if ("status" in begun) throw new Error(begun.message);
		return begun.runId;
	}

	/** Moves a run to when it began, and to when it ended unless it is still going. */
	function moveRun(instance: RegistryDO, runId: string, startedAt: number, endedAt?: number) {
		// A test may reach the storage of the Durable Object it runs in, and only that one.
		const { sql } = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
		sql.exec("UPDATE runs SET started_at = ? WHERE id = ?", startedAt, runId);
		if (endedAt !== undefined) {
			sql.exec("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?", endedAt, runId);
		}
	}

	function midnight() {
		const now = new Date();
		return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	}

	it("counts each conversation's sandbox from a turn until it sleeps, within the day", async () => {
		const stub = registry();
		const [first = "", second = ""] = await builderConversations(stub, 2);
		const plain = await withAgent(stub);
		const chat = (await stub.startConversation(plain.id, ADA))?.id ?? "";
		const today = midnight();
		const at = today + 60 * MINUTE;
		await withSandboxes(stub, async (instance) => {
			// Two turns of one conversation, close enough to share its sandbox: 10 minutes of turn,
			// 4 asleep, then 10 more and the sandbox's idle minutes.
			moveRun(instance, await turn(instance, first), at, at + 10 * MINUTE);
			moveRun(instance, await turn(instance, first), at + 14 * MINUTE, at + 24 * MINUTE);
			// A sandbox that went on past midnight counts from midnight.
			moveRun(instance, await turn(instance, second), today - 20 * MINUTE, today - 2 * MINUTE);
			// A turn without a sandbox counts for nothing.
			moveRun(instance, await turn(instance, chat), at, at + 10 * MINUTE);
		});
		const minutes = 24 + IDLE + (IDLE - 2);
		expect(await stub.sandboxSecondsToday()).toBe(minutes * 60);
	});

	it("gives each run the sandbox time until its conversation's next turn, adding up to the day's", async () => {
		const stub = registry();
		const [first = ""] = await builderConversations(stub, 1);
		const plain = await withAgent(stub);
		const chat = (await stub.startConversation(plain.id, ADA))?.id ?? "";
		const at = midnight() + 60 * MINUTE;
		const ids = await withSandboxes(stub, async (instance) => {
			const one = await turn(instance, first);
			const two = await turn(instance, first);
			const none = await turn(instance, chat);
			moveRun(instance, one, at, at + 10 * MINUTE);
			moveRun(instance, two, at + 14 * MINUTE, at + 24 * MINUTE);
			moveRun(instance, none, at, at + 10 * MINUTE);
			return { one, two, none };
		});
		const seconds = async (id: string) => (await stub.getRun(id))?.sandboxSeconds;
		// The first turn's sandbox ran on until the second turn took it over.
		expect(await seconds(ids.one)).toBe(14 * 60);
		expect(await seconds(ids.two)).toBe((10 + IDLE) * 60);
		expect(await seconds(ids.none)).toBeNull();
		// Each second of the sandbox belongs to one run, so the runs add up to what the limits count.
		expect((24 + IDLE) * 60).toBe(await stub.sandboxSecondsToday());
		const total = (await stub.getRun(ids.two))?.total;
		expect(total).toMatchObject({
			sandboxSeconds: (10 + IDLE) * 60,
			sandboxCost: Math.round((10 + IDLE) * 60 * SANDBOX_SECOND_PRICE * 1_000_000),
		});
	});

	it("are refused once the workspace has used the day's minutes", async () => {
		const stub = registry();
		const [first = "", second = ""] = await builderConversations(stub, 2);
		const at = midnight() + 60 * MINUTE;
		await withSandboxes(stub, async (instance) => {
			// 10 minutes of turn, and the sandbox's idle minutes after it.
			moveRun(instance, await turn(instance, first), at, at + 10 * MINUTE);
		});
		const used = 10 + IDLE;
		await withSandboxes(
			stub,
			async (instance) => {
				expect(await instance.beginTurn(second, "Build it")).toEqual({
					status: "refused",
					message: `${SANDBOX_DAY_USED}, ${used} minutes, so Builder cannot answer until the day ends (UTC).`,
				});
			},
			{ limits: { SANDBOX_DAILY_MINUTES: String(used) } },
		);
		await withSandboxes(
			stub,
			async (instance) => {
				expect(await instance.beginTurn(second, "Build it")).toMatchObject({ sandbox: true });
			},
			{ limits: { SANDBOX_DAILY_MINUTES: String(used + 1) } },
		);
	});

	it("lets a running sandbox turn finish and refuses new turns at the monthly cap until reset", async () => {
		const stub = registry();
		const [first = "", second = ""] = await builderConversations(stub, 2);
		const start = Date.UTC(2026, 11, 15, 10);
		const cap = 10 + IDLE;
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					expect(instance.sandboxSecondsThisMonth()).toBe(0);
					const run = await turn(instance, first);
					const atCap = start + 10 * MINUTE;
					clock.mockReturnValue(atCap);
					expect(instance.sandboxSecondsThisMonth()).toBe(cap * 60);
					expect(instance.getRun(run)).toMatchObject({ status: "running" });
					expect(instance.finishRun(run, { ...done, endedAt: atCap })).toBe(true);
					expect(instance.getRun(run)).toMatchObject({ status: "succeeded", endedAt: atCap });

					const refusal = {
						status: "refused",
						message: `${SANDBOX_MONTH_USED}, ${cap} minutes, so Builder cannot answer until the month ends (UTC). It resets on 2027-01-01.`,
					};
					expect(await instance.beginTurn(second, "Build it")).toEqual(refusal);
					const listed = instance.listRuns();
					expect(listed[0]).toMatchObject({
						conversationId: second,
						status: "refused",
						error: refusal.message,
						steps: 0,
						inputTokens: 0,
						outputTokens: 0,
						cost: 0,
						sandbox: false,
					});
					clock.mockReturnValue(Date.UTC(2026, 11, 16));
					expect(instance.sandboxSecondsToday()).toBe(0);
					expect(await instance.beginTurn(second, "Build it")).toEqual(refusal);

					clock.mockReturnValue(Date.UTC(2027, 0, 1));
					expect(instance.sandboxSecondsThisMonth()).toBe(0);
					expect(await instance.beginTurn(second, "Build it")).toMatchObject({ sandbox: true });
				},
				{ limits: { SANDBOX_MONTHLY_MINUTES: String(cap) } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("names the month's reset when the pool is full and the month's minutes are used up", async () => {
		const stub = registry();
		const ids = await builderConversations(stub, MAX_WORKSPACE_SANDBOXES + 1);
		const target = ids.pop() ?? "";
		const start = Date.UTC(2026, 11, 15, 10);
		const cap = 10 + IDLE;
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					for (const id of ids) await turn(instance, id);
					clock.mockReturnValue(start + 10 * MINUTE);
					// Lower the cap only once the pool is full, so filling it did not refuse a turn.
					(instance as unknown as { env: Record<string, unknown> }).env.SANDBOX_MONTHLY_MINUTES =
						String(cap);
					expect(await instance.beginTurn(target, "Build it")).toEqual({
						status: "refused",
						message: `${SANDBOX_MONTH_USED}, ${cap} minutes, so Builder cannot answer until the month ends (UTC). It resets on 2027-01-01.`,
					});
				},
				{ limits: { SANDBOX_MONTHLY_MINUTES: "1000" } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("names the month's reset when the day's and the month's minutes are both used up", async () => {
		const stub = registry();
		const [first = "", second = ""] = await builderConversations(stub, 2);
		const start = Date.UTC(2026, 11, 15, 10);
		const cap = 10 + IDLE;
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					const run = await turn(instance, first);
					const atCap = start + 10 * MINUTE;
					clock.mockReturnValue(atCap);
					instance.finishRun(run, { ...done, endedAt: atCap });
					expect(await instance.beginTurn(second, "Build it")).toEqual({
						status: "refused",
						message: `${SANDBOX_MONTH_USED}, ${cap} minutes, so Builder cannot answer until the month ends (UTC). It resets on 2027-01-01.`,
					});
				},
				{ limits: { SANDBOX_DAILY_MINUTES: String(cap), SANDBOX_MONTHLY_MINUTES: String(cap) } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("retries a monthly minutes alert whose delivery failed, then sends it once", async () => {
		const stub = registry();
		const [conversation = ""] = await builderConversations(stub, 1);
		const start = Date.UTC(2026, 11, 15, 10);
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					const test = instance as unknown as TestRegistry;
					test.failMinutesAlerts(1);
					const finish = async (at: number) => {
						const run = await turn(instance, conversation);
						clock.mockReturnValue(at);
						expect(instance.finishRun(run, { ...done, endedAt: at })).toBe(true);
					};
					await finish(start + 11 * MINUTE);
					await vi.waitFor(() => expect(test.failedMinutesAlerts()).toBe(1));
					expect(test.minutesPassed()).toEqual([]);

					await finish(start + 12 * MINUTE);
					await vi.waitFor(() =>
						expect(test.minutesPassed()).toEqual([
							expect.objectContaining({ share: 80, month: "2026-12" }),
						]),
					);
					await finish(start + 13 * MINUTE);
					await new Promise((resolve) => setTimeout(resolve, 20));
					expect(test.minutesPassed()).toHaveLength(1);
					expect(test.failedMinutesAlerts()).toBe(1);
				},
				{ limits: { SANDBOX_MONTHLY_MINUTES: "20" } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("alerts once at each monthly minutes threshold and starts over in the next UTC month", async () => {
		const stub = registry();
		const [conversation = ""] = await builderConversations(stub, 1);
		const december = Date.UTC(2026, 11, 15, 10);
		const january = Date.UTC(2027, 0, 15, 10);
		const cap = 20;
		const clock = vi.spyOn(Date, "now").mockReturnValue(december);
		const firstMonth = { cap, month: "2026-12", resetsOn: "2027-01-01" };
		const secondMonth = { cap, month: "2027-01", resetsOn: "2027-02-01" };
		const warning = { ...firstMonth, share: 80, minutes: 16 };
		const reached = { ...firstMonth, share: 100, minutes: 20 };
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					const heard = () => (instance as unknown as TestRegistry).minutesPassed();
					const finish = (id: string, at: number) => {
						clock.mockReturnValue(at);
						expect(instance.finishRun(id, { ...done, endedAt: at })).toBe(true);
					};
					finish(await turn(instance, conversation), december + (15 - IDLE) * MINUTE);
					expect(heard()).toEqual([]);

					const atWarning = december + (16 - IDLE) * MINUTE;
					clock.mockReturnValue(atWarning);
					finish(await turn(instance, conversation), atWarning);
					expect(heard()).toEqual([warning]);

					// Two turns begin below the cap. The second closes after the first reaches it.
					const atCap = december + (cap - IDLE) * MINUTE;
					const third = await turn(instance, conversation);
					const fourth = await turn(instance, conversation);
					finish(third, atCap);
					expect(heard()).toEqual([warning, reached]);
					finish(fourth, atCap + MINUTE);
					expect(heard()).toEqual([warning, reached]);

					clock.mockReturnValue(january);
					finish(await turn(instance, conversation), january + (cap - IDLE) * MINUTE);
					await vi.waitFor(() =>
						expect(heard()).toEqual([
							warning,
							reached,
							{ ...secondMonth, share: 80, minutes: cap },
							{ ...secondMonth, share: 100, minutes: cap },
						]),
					);
				},
				{ limits: { SANDBOX_MONTHLY_MINUTES: String(cap) } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("retries a budget alert whose delivery failed, then sends it once", async () => {
		const stub = registry();
		const [first = "", second = ""] = await builderConversations(stub, 2);
		const start = Date.UTC(2025, 0, 1);
		const firstMinutes = 6 + IDLE;
		const budget = ((firstMinutes * 60) / 0.84) * SANDBOX_SECOND_PRICE;
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					const test = instance as unknown as TestRegistry;
					const run = await turn(instance, first);
					const ended = start + 6 * MINUTE;
					clock.mockReturnValue(ended);
					test.failBudgetAlerts(1);
					expect(instance.finishRun(run, { ...done, endedAt: ended })).toBe(true);
					await vi.waitFor(() => expect(test.failedBudgetAlerts()).toBe(1));
					expect(test.budgetPassed()).toEqual([]);

					// The retry goes through the meter, in another object, before the next report can pass it again.
					await vi.waitFor(async () => {
						const readings = await env.SANDBOX_METER.getByName(METER_NAME).readings();
						const heard = readings.find(([key]) => key === "alerts:2025-01")?.[1];
						expect(Array.isArray(heard) && heard.includes(80)).toBe(false);
					});
					const retry = await turn(instance, second);
					await vi.waitFor(() =>
						expect(test.budgetPassed()).toEqual([expect.objectContaining({ share: 80, budget })]),
					);
					expect(instance.finishRun(retry, { ...done, endedAt: ended })).toBe(true);
					await new Promise((resolve) => setTimeout(resolve, 20));
					expect(test.budgetPassed().filter(({ share }) => share === 80)).toHaveLength(1);
					expect(test.failedBudgetAlerts()).toBe(1);
				},
				{ limits: { SANDBOX_MONTHLY_BUDGET: String(budget) } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("checks the closing month's minutes when a run ends after midnight", async () => {
		const stub = registry();
		const [conversation = ""] = await builderConversations(stub, 1);
		const start = Date.UTC(2026, 11, 31, 23, 12);
		const close = Date.UTC(2027, 0, 1, 0, 1);
		const cap = 60;
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					const run = await turn(instance, conversation);
					clock.mockReturnValue(close);
					expect(instance.finishRun(run, { ...done, endedAt: close })).toBe(true);
					const heard = () => (instance as unknown as TestRegistry).minutesPassed();
					await vi.waitFor(() =>
						expect(heard()).toEqual([
							{ share: 80, minutes: 48, cap, month: "2026-12", resetsOn: "2027-01-01" },
						]),
					);
				},
				{ limits: { SANDBOX_MONTHLY_MINUTES: String(cap) } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("checks the closing month's deployment budget when a run ends after midnight", async () => {
		const stub = registry();
		const [conversation = ""] = await builderConversations(stub, 1);
		const start = Date.UTC(2026, 11, 31, 23, 12);
		const close = Date.UTC(2027, 0, 1, 0, 1);
		const budget = 60 * 60 * SANDBOX_SECOND_PRICE;
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		try {
			await withSandboxes(
				stub,
				async (instance) => {
					const run = await turn(instance, conversation);
					clock.mockReturnValue(close);
					expect(instance.finishRun(run, { ...done, endedAt: close })).toBe(true);
					const heard = () => (instance as unknown as TestRegistry).budgetPassed();
					await vi.waitFor(() =>
						expect(heard()).toEqual([
							{
								share: 80,
								spent: expect.closeTo(48 * 60 * SANDBOX_SECOND_PRICE, 10),
								budget,
								month: "2026-12",
							},
						]),
					);
				},
				{ limits: { SANDBOX_MONTHLY_BUDGET: String(budget) } },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("are refused once the server has spent the month's budget, which its operator hears of", async () => {
		const stub = registry();
		const [first = "", second = "", third = ""] = await builderConversations(stub, 3);
		const now = new Date();
		const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
		const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
		// The first conversation's sandbox runs 6 minutes of turn and its idle minutes, which is 84%
		// of the budget; the second's 5 minutes more and as many idle ones go past it.
		const firstMinutes = 6 + IDLE;
		const budget = ((firstMinutes * 60) / 0.84) * SANDBOX_SECOND_PRICE;
		const limits = { SANDBOX_MONTHLY_BUDGET: String(budget) };
		const heard = (instance: RegistryDO) => (instance as unknown as TestRegistry).budgetPassed();
		await withSandboxes(
			stub,
			async (instance) => {
				moveRun(instance, await turn(instance, first), start + 60 * MINUTE, start + 66 * MINUTE);
				// The meter hears as the next turn begins.
				const next = await turn(instance, second);
				expect(heard(instance)).toEqual([
					{
						share: 80,
						spent: expect.closeTo(firstMinutes * 60 * SANDBOX_SECOND_PRICE, 10),
						budget,
						month,
					},
				]);
				// And again as that turn ends.
				moveRun(instance, next, start + 120 * MINUTE);
				expect(instance.finishRun(next, { ...done, endedAt: start + 125 * MINUTE })).toBe(true);
				await vi.waitFor(() => expect(heard(instance)).toHaveLength(2));
				expect(heard(instance)[1]).toEqual({
					share: 100,
					spent: expect.closeTo((firstMinutes + 5 + IDLE) * 60 * SANDBOX_SECOND_PRICE, 10),
					budget,
					month,
				});
				expect(await instance.beginTurn(third, "Build it")).toEqual({
					status: "refused",
					message: `${SANDBOX_BUDGET_SPENT}, so Builder cannot answer until the month ends (UTC). Whoever runs this server can raise it.`,
				});
			},
			{ limits },
		);
		// Each share is told once a month.
		expect(await stub.budgetPassed()).toHaveLength(2);
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
			saveAgent(stub, agent.id, { ...builder(site), name: "Fixer" }),
		).resolves.toMatchObject({ name: "Fixer" });
		await runInDurableObject(stub, (instance: RegistryDO) => {
			expect(() => instance.createAgent(builder(site))).toThrow(
				"The workspace's GitHub App no longer reaches acme/site",
			);
		});
	});
});

it("refuses a paused agent before resolving its provider, and resumes its turns", async () => {
	const stub = registry();
	const { id } = await withAgent(stub);
	const conversation = (await stub.startConversation(id, ADA))?.id ?? "";
	expect(await stub.resumeAgent(id)).toBe(false);
	const first = await stub.pauseAgent(id, ADA);
	expect(first).toMatchObject({ by: ADA, at: expect.any(Number), changed: true });
	expect(await stub.pauseAgent(id, GRACE)).toEqual({ ...first, changed: false });
	expect((await stub.getAgent(id))?.agent.paused).toEqual({ by: ADA, at: first?.at });
	const pause = "This agent is paused, so it takes no new turns. An owner or admin can resume it.";
	expect(await stub.beginTurn(conversation, "Hello")).toEqual({
		status: "refused",
		message: pause,
	});
	const refusedRuns = await stub.listRuns();
	expect(refusedRuns).toHaveLength(1);
	expect(refusedRuns[0]).toMatchObject({
		conversationId: conversation,
		status: "refused",
		error: pause,
		steps: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		sandbox: false,
	});
	expect(await stub.resumeAgent(id)).toBe(true);
	await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, ADA);
	expect(await stub.beginTurn(conversation, "Again")).toHaveProperty("runId");
	await stub.pauseAgent(id, GRACE);
	await stub.removeAgent(id);
	// A run under way reads the pause by id, so removing the agent does not hide it.
	expect(await stub.agentPause(id)).toMatchObject({ by: GRACE });
	expect(await stub.getAgent(id)).toBeNull();
	expect(await stub.pauseAgent(id, ADA)).toBeNull();
	expect(await stub.resumeAgent(id)).toBe(false);
	expect(await stub.pauseAgent("missing", ADA)).toBeNull();
});
