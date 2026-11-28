import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	RUN_TIMEOUT_MS,
	TRACK_WORK_PROMPT,
	TRACK_WORK_RUNS_PER_DAY,
	TRACK_WORK_TOOLS,
	type TrackSourceSave,
	type TrackWorkPlan,
} from "@gateweave/agents-model";
import { describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";
import { sealerFor } from "../src/secrets";
import { trackSourceKeyPlace } from "../src/track-sources";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;
// A refusal thrown over RPC is also reported as unhandled, so those calls are made inside.
const inside = <T>(stub: Stub, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

const ADA = "user-ada";
const AGENT_KEY = `gwt_${"k".repeat(43)}`;
const trackOrigin = "https://track.example.com";
const sourceKey = `gws_${"s".repeat(43)}`;

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

async function reportingWork() {
	const stub = registry();
	const repositoryId = await withRepository(stub);
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
	const destinationId = crypto.randomUUID();
	const source = {
		trackOrigin,
		sourceKey,
		source: { id: "source", name: "Gateweave Agents", product: "agents" },
		workspace: { id: "workspace", slug: "acme", name: "Acme" },
		team: { id: "team", key: "OPS", name: "Operations" },
	} satisfies TrackSourceSave;
	expect(await stub.saveTrackSource(destinationId, source)).toBe("saved");
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
	const deliver = async (id: string, now: number) => {
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
	return { stub, trigger, source, destinationId, deliver };
}

it("reuses an expired reservation, and orders the reports even if the clock does not advance", async () => {
	const { stub, trigger, destinationId, deliver } = await reportingWork();
	await runInDurableObject(stub, async (_instance: RegistryDO, state) => {
		const sealer = await sealerFor(
			{ BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET },
			state.id.toString(),
		);
		if ("unavailable" in sealer) throw new Error(sealer.unavailable);
		const sealed = await sealer.seal(trackSourceKeyPlace(destinationId, trackOrigin), sourceKey);
		state.storage.sql.exec(
			"UPDATE track_source_destinations SET sealed_key = ? WHERE id = ?",
			sealed,
			destinationId,
		);
	});
	expect((await stub.sealedCounts()).derived).toBe(1);

	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const reports: { state: string; sentAt: string; key: string; url?: string }[] = [];
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		expect(url).toBe(`${trackOrigin}/api/events`);
		expect(init?.redirect).toBe("manual");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sourceKey}`);
		reports.push(JSON.parse(String(init?.body)));
		return new Response(null, { status: 202 });
	});
	try {
		const first = await deliver("assignment", now);
		if (first.status !== "start") throw new Error(first.status);
		expect((await deliver("assignment", now)).status).toBe("starting");
		await vi.waitFor(() => expect(reports).toHaveLength(1));
		expect((await stub.sealedCounts()).derived).toBe(0);
		const queued = reports[0];
		now += 60_001;
		const retry = await deliver("assignment", now);
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
		await vi.waitFor(() => expect(reports).toHaveLength(3));
		expect(reports[2]).toMatchObject({ key: run.runId, state: "failed" });

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
		await vi.waitFor(() => expect(reports).toHaveLength(4));
		const running = reports.find((report) => report.state === "running");
		expect(running).toMatchObject({ key: run.runId, sentAt: new Date(now).toISOString() });
		const failed = reports.at(-1);
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

it("replays the stored lifecycle after rate limiting, eviction and a network outage", async () => {
	const { stub, deliver } = await reportingWork();
	let now = Date.now() + 5_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const posts: string[] = [];
	let outage: "rate-limit" | "network" | null = "rate-limit";
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		posts.push(String(init?.body));
		if (outage === "rate-limit") {
			return new Response(null, { status: 429, headers: { "retry-after": "90" } });
		}
		if (outage === "network") throw new TypeError("Track is unreachable");
		return Response.json({ filed: false });
	});
	const alarm = () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
	try {
		const admitted = await deliver("assignment", now);
		if (admitted.status !== "start") throw new Error(admitted.status);
		const run = await stub.beginTriggerTurn(
			admitted.conversationId,
			admitted.text,
			admitted.attemptId,
		);
		if ("status" in run) throw new Error(run.message);
		expect(
			await stub.finishRun(run.runId, {
				status: "succeeded",
				error: null,
				endedAt: now,
				steps: 0,
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				cost: null,
			}),
		).toBe(true);
		expect(await stub.getRun(run.runId)).toMatchObject({ status: "succeeded" });
		await vi.waitFor(async () => {
			expect(posts).toHaveLength(3);
			expect(await alarm()).toBe(now + 90_000);
		});
		const original = posts.slice().sort();
		const reportStates = original.map((post) => JSON.parse(post).state).sort();
		expect(reportStates).toEqual(["passed", "queued", "running"]);

		await evictDurableObject(stub);
		now += 89_999;
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(posts).toHaveLength(3);
		expect(await alarm()).toBe(now + 1);

		outage = "network";
		now += 1;
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(posts.slice(3).sort()).toEqual(original);
		expect(await alarm()).toBe(now + 30_000);

		outage = null;
		now += 30_000;
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(posts.slice(6).sort()).toEqual(original);
		expect(await alarm()).toBeNull();
	} finally {
		fetcher.mockRestore();
		clock.mockRestore();
	}
});

it("clears pending reports when the destination is disconnected", async () => {
	const { stub, source, destinationId, deliver } = await reportingWork();
	let now = Date.now() + 5_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(null, { status: 503 }));
	try {
		expect((await deliver("assignment", now)).status).toBe("start");
		await vi.waitFor(async () => {
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
				now + 15_000,
			);
		});
		expect(await stub.removeTrackSource(destinationId)).toBe(true);
		expect(
			await stub.saveTrackSource(crypto.randomUUID(), {
				...source,
				source: { ...source.source, id: "replacement" },
			}),
		).toBe("saved");
		now += 15_000;
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			await runInDurableObject(stub, (_instance, state) =>
				state.storage.sql.exec("SELECT id FROM track_report_outbox").toArray(),
			),
		).toEqual([]);
	} finally {
		fetcher.mockRestore();
		clock.mockRestore();
	}
});

it("drops a refused report even when its answer's body cannot be cancelled", async () => {
	const { stub, deliver } = await reportingWork();
	const now = Date.now() + 5_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						throw new Error("The answer's stream could not be cancelled");
					},
				}),
				{ status: 404 },
			),
	);
	const alarm = () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
	try {
		expect((await deliver("assignment", now)).status).toBe("start");
		// The 404 decides it, not the cleanup: no retry is planned.
		await vi.waitFor(async () => {
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(await alarm()).toBeNull();
		});
	} finally {
		fetcher.mockRestore();
		clock.mockRestore();
	}
});

it.each([404, 503])("does not keep a Track report indefinitely after HTTP %i", async (status) => {
	const { stub, deliver } = await reportingWork();
	let now = Date.now() + 5_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
	const alarm = () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
	try {
		expect((await deliver("assignment", now)).status).toBe("start");
		await vi.waitFor(async () => {
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(await alarm()).toBe(status === 404 ? null : now + 15_000);
		});
		// A refused credential has no retry. An unavailable source has only a day to recover.
		now += 24 * 60 * 60_000;
		expect(await runDurableObjectAlarm(stub)).toBe(status === 503);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await alarm()).toBeNull();
	} finally {
		fetcher.mockRestore();
		clock.mockRestore();
	}
});
