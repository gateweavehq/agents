import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	RUN_TIMEOUT_MS,
	TRACK_WORK_PROMPT,
	TRACK_WORK_RUNS_PER_DAY,
	TRACK_WORK_TOOLS,
	type TrackWorkPlan,
} from "@gateweave/agents-model";
import { describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;
// A refusal thrown over RPC is also reported as unhandled, so those calls are made inside.
const inside = <T>(stub: Stub, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

const ADA = "user-ada";
const AGENT_KEY = `gwt_${"k".repeat(43)}`;

/** A repository the workspace's GitHub App reaches. */
async function withRepository(stub: Stub) {
	const [id = ""] = await stub.syncRepositories([
		{
			provider: "github",
			externalId: "7",
			installationId: "99",
			owner: "acme",
			name: "site",
			defaultBranch: "main",
			private: true,
		},
	]);
	return id;
}

function plan(repositoryId: string, rest: Partial<TrackWorkPlan> = {}): TrackWorkPlan {
	return {
		trackUrl: "https://track.example.com/acme",
		agentKey: AGENT_KEY,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		engine: "claude-code",
		repositoryId,
		instructions: "Work on the issues assigned to you.\n",
		memberId: "member-coder",
		memberName: "Coder",
		...rest,
	};
}

describe("Track work", () => {
	it("makes an agent with a sandbox on the repository, and a trigger for its member's issues", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const made = await stub.setUpTrackWork(plan(repositoryId), ADA, "Ada");
		if ("status" in made) throw new Error(made.message);
		const { agent, trigger, mcpServerId } = made;
		expect(agent).toMatchObject({
			name: "Coder",
			runtime: "gateweave",
			description:
				"Works on the issues assigned to it in Gateweave Track (track.example.com), and opens a pull request of its work.",
		});
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			sandbox: true,
			engine: "claude-code",
			repository: { id: repositoryId },
			mcpServers: [expect.objectContaining({ tools: [...TRACK_WORK_TOOLS] })],
		});
		expect(trigger).toMatchObject({
			name: "Assigned issues",
			prompt: TRACK_WORK_PROMPT,
			target: { kind: "agent", agentId: agent.id },
			// A person's comment on one of its issues continues that issue's conversation.
			events: ["issue.created", "issue.updated", "comment.created"],
			label: null,
			assignee: "member-coder",
			// Shown in place of the id, as Track calls the member.
			assigneeName: "Coder",
			perIssue: true,
			perDay: TRACK_WORK_RUNS_PER_DAY,
			active: true,
		});

		// The key is the environment set's secret, as triage keeps it, and no page shows it.
		const [server] = await stub.listMcpServers();
		expect(server?.asset).toMatchObject({ id: mcpServerId, name: "track" });
		// Only the runtime gets it, in the server's header.
		expect(await stub.mcpCheckTarget(mcpServerId)).toMatchObject({
			url: "https://track.example.com/mcp",
			headers: { Authorization: `Bearer ${AGENT_KEY}` },
		});
		const pages = JSON.stringify([await stub.listEnvSets(), await stub.listMcpServers()]);
		expect(pages).toContain("https://track.example.com/mcp");
		expect(pages).not.toContain(AGENT_KEY);
		const [instructions] = (await stub.listLibrary()).filter(
			(entry) => entry.asset.kind === "instructions",
		);
		expect(instructions?.asset.name).toBe("Track issue work");
	});

	it("makes nothing when the engine does not fit the model, or the repository is not there", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		await expect(
			inside(stub, (instance) =>
				instance.setUpTrackWork(plan(repositoryId, { engine: "codex" }), ADA, "Ada"),
			),
		).rejects.toThrow("Codex calls OpenAI's models");
		await expect(
			inside(stub, (instance) => instance.setUpTrackWork(plan("no-such-repository"), ADA, "Ada")),
		).rejects.toThrow("There is no such repository in the workspace");
		expect(await stub.listMcpServers()).toEqual([]);
		expect(await stub.listEnvSets()).toEqual([]);
		expect(await stub.listTriggers()).toEqual([]);
	});
});

it("reuses an expired reservation, and orders the reports even if the clock does not advance", async () => {
	const stub = registry();
	const repositoryId = await withRepository(stub);
	const trackOrigin = "https://track.example.com";
	const secret = `whsec_${btoa("w".repeat(32))}`;
	const made = await stub.setUpTrackWork(plan(repositoryId), ADA, "Ada", {
		triggerId: crypto.randomUUID(),
		webhookSecret: secret,
	});
	if ("status" in made) throw new Error(made.message);
	const { agent, trigger } = made;
	const definition = (await stub.getAgent(agent.id))?.definition;
	if (!definition?.environment) throw new Error("Missing pinned environment");
	await stub.updateAgent(
		agent.id,
		{
			...definition,
			name: agent.name,
			description: agent.description,
			instructions: null,
			environment: {
				assetId: definition.environment.asset.id,
				version: definition.environment.version,
			},
			mcpServers: [],
			engine: "gateweave",
			repositoryId: null,
			sandbox: false,
		},
		agent.updatedAt,
	);
	await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-test-track-report" }, "Ada");
	await stub.saveTrackSource(crypto.randomUUID(), {
		trackOrigin,
		sourceKey: `gws_${"s".repeat(43)}`,
		source: { id: "source", name: "Gateweave Agents", product: "agents" },
		workspace: { id: "workspace", slug: "acme", name: "Acme" },
		team: { id: "team", key: "OPS", name: "Operations" },
	});

	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const reports: { state: string; sentAt: string; key: string; url?: string }[] = [];
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		expect(url).toBe(`${trackOrigin}/api/events`);
		expect(init?.redirect).toBe("manual");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		reports.push(JSON.parse(String(init?.body)));
		return new Response(null, { status: 202 });
	});
	const body = JSON.stringify({
		type: "issue.created",
		data: {
			workspace: { id: "workspace", slug: "acme" },
			issue: {
				id: "issue",
				key: "OPS-42",
				teamId: "team",
				url: `${trackOrigin}/acme/issue/OPS-42`,
				assigneeId: "member-coder",
			},
		},
	});
	const sign = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode("w".repeat(32)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const deliver = async (id: string) => {
		const timestamp = String(Math.floor(now / 1000));
		const mac = await crypto.subtle.sign(
			"HMAC",
			sign,
			new TextEncoder().encode(`${id}.${timestamp}.${body}`),
		);
		return stub.receiveTrigger(
			trigger.id,
			{
				id,
				timestamp,
				signature: `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`,
			},
			body,
			"https://agents.example.test/acme/runs/?untrusted=1",
		);
	};
	try {
		const first = await deliver("assignment");
		if (first.status !== "start") throw new Error(first.status);
		expect((await deliver("assignment")).status).toBe("starting");
		await vi.waitFor(() => expect(reports).toHaveLength(1));
		const queued = reports[0];
		now += 60_001;
		const retry = await deliver("assignment");
		if (retry.status !== "start") throw new Error(retry.status);
		expect(retry.attemptId).not.toBe(first.attemptId);
		const late = await stub.beginTriggerTurn(retry.conversationId, first.text, first.attemptId);
		expect(late).toMatchObject({ status: "refused" });
		expect(await stub.beginTriggerTurn(retry.conversationId, first.text)).toMatchObject({
			status: "refused",
		});
		const run = await stub.beginTriggerTurn(retry.conversationId, retry.text, retry.attemptId);
		if ("status" in run) throw new Error(run.message);
		expect(run.runId).toBe(queued?.key);
		await vi.waitFor(() => expect(reports).toHaveLength(2));
		const startedAt = now;
		now += RUN_TIMEOUT_MS + 1;
		expect(await stub.getRun(run.runId)).toMatchObject({ status: "interrupted", endedAt: null });
		expect(reports).toHaveLength(2);

		await stub.deleteTrigger(trigger.id);
		// Arrival time can be the same as running's timestamp, even after a clock adjustment.
		now = startedAt;
		expect(
			await stub.finishRun(run.runId, {
				status: "interrupted",
				endedAt: now,
				error: "Private detail",
				steps: 0,
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				cost: null,
			}),
		).toBe(true);
		await vi.waitFor(() => expect(reports).toHaveLength(3));
		const running = reports.find((report) => report.state === "running");
		expect(running).toMatchObject({ key: run.runId, sentAt: new Date(now).toISOString() });
		const failed = reports.find((report) => report.state === "failed");
		expect(failed).toMatchObject({
			key: run.runId,
			sentAt: new Date(now + 1).toISOString(),
			progress: "Run did not complete successfully",
		});
		expect(reports.every(({ url }) => url === undefined)).toBe(true);
	} finally {
		fetcher.mockRestore();
		clock.mockRestore();
	}
});
