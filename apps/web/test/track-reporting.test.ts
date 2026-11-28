import { createHmac, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { FakeModels } from "./fake-models";

const origin = "https://agents.test";
const track = "https://track.test:8443";
const otherTrack = "https://other-track.test:8443";
const model = "claude-sonnet-5-5";
const providerKey = "sk-ant-test-hosted-track";
const agentName = "Workbench ".repeat(8).trim();
const issue = "OPS-42";
const models = new FakeModels({ [providerKey]: { provider: "anthropic", models: [model] } });
const reports: {
	url: string;
	method: string;
	auth: string | null;
	contentType: string | null;
	body: { state: string; key: string; issue: string; sentAt: string } & Record<string, unknown>;
}[] = [];

let answerReport: (report: (typeof reports)[number]) => Response | Promise<Response>;
async function report(request: Request) {
	const received = {
		url: request.url,
		method: request.method,
		auth: request.headers.get("authorization"),
		contentType: request.headers.get("content-type"),
		body: (await request.json()) as (typeof reports)[number]["body"],
	};
	reports.push(received);
	return answerReport(received);
}

let agents: Awaited<ReturnType<typeof startAgents>>;
beforeAll(async () => {
	agents = await startAgents(origin, {
		models,
		hosts: { [new URL(track).host]: report, [new URL(otherTrack).host]: report },
		settings: { SANDBOX: "1" },
	});
});
afterEach(() => {
	reports.length = 0;
	models.script = undefined;
	answerReport = () => new Response(null, { status: 202 });
});
afterAll(async () => agents?.dispose());
answerReport = () => new Response(null, { status: 202 });

async function setup(slug: string, { key = true, sandbox = false } = {}) {
	const owner = await signUp(agents, origin, slug);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	if (key)
		await registry.saveProviderKey({ provider: "anthropic", key: providerKey }, owner.userId);
	const [repositoryId = ""] = await registry.syncRepositories([
		{
			provider: "github",
			externalId: "42",
			installationId: "99",
			owner: "private-repository-owner",
			name: "private-repository-name",
			defaultBranch: "main",
			private: true,
		},
	]);
	const made = await registry.setUpTrackWork(
		{
			trackUrl: track,
			agentKey: `gwt_${"a".repeat(43)}`,
			name: agentName,
			provider: "anthropic",
			model,
			engine: "gateweave",
			repositoryId,
			instructions: "Private agent instructions",
			memberId: "track-agent",
			memberName: "Workbench",
		},
		owner.userId,
		"Owner",
	);
	if ("status" in made) throw new Error(made.message);
	if (!sandbox) {
		// Keep the Track Work trigger and pinned key and exercise the real hosted model loop.
		const definition = (await registry.getAgent(made.agent.id))?.definition;
		if (!definition) throw new Error("Missing Track agent definition");
		expect(
			await registry.updateAgent(
				made.agent.id,
				{
					...definition,
					instructions: null,
					environment: definition.environment && {
						assetId: definition.environment.asset.id,
						version: definition.environment.version,
					},
					name: agentName,
					description: null,
					sandbox: false,
					repositoryId: null,
					mcpServers: [],
				},
				made.agent.updatedAt,
			),
		).toBeTruthy();
	}
	const senderSecret = `whsec_${randomBytes(32).toString("base64")}`;
	await registry.replaceTriggerSecret(made.trigger.id, senderSecret);
	const connect = async (trackOrigin = track) => {
		const destinationId = crypto.randomUUID();
		const sourceKey = `gws_${randomBytes(32).toString("base64url")}`;
		expect(
			await registry.saveTrackSource(destinationId, {
				trackOrigin,
				sourceKey,
				source: { id: crypto.randomUUID(), name: "Gateweave Agents", product: "agents" },
				workspace: { id: "track-workspace", slug: "operations", name: "Operations" },
				team: { id: "track-team", key: "OPS", name: "Operations" },
			}),
		).toBe("saved");
		return { destinationId, sourceKey };
	};
	type Options = {
		id?: string;
		trackOrigin?: string;
		teamId?: string;
		workspace?: string;
		valid?: boolean;
		type?: string;
		assignee?: string;
		issueKey?: string;
	};
	const post = async ({
		id = crypto.randomUUID(),
		trackOrigin = track,
		teamId = "track-team",
		workspace = "track-workspace",
		valid = true,
		type = "issue.updated",
		assignee = "track-agent",
		issueKey = issue,
	}: Options = {}) => {
		const body = JSON.stringify({
			type,
			data: {
				workspace: { id: workspace, slug: "operations" },
				issue: {
					id: `id-${issueKey}`,
					key: issueKey,
					teamId,
					url: `${trackOrigin}/operations/issue/${issueKey}`,
					assignee: { id: assignee, name: "Workbench" },
					assigneeId: assignee,
					title: "Private issue title",
					description: "Private issue body",
				},
				updatedFrom: { assigneeId: null },
			},
		});
		const timestamp = String(Math.floor(Date.now() / 1000));
		const mac = createHmac("sha256", Buffer.from(senderSecret.slice(6), "base64"))
			.update(`${id}.${timestamp}.${body}`)
			.digest("base64");
		return agents.fetch(`${origin}/api/triggers/${workspaceId}/${made.trigger.id}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"webhook-id": id,
				"webhook-timestamp": timestamp,
				"webhook-signature": valid ? `v1,${mac}` : "v1,bm8=",
				"cf-connecting-ip": owner.headers["cf-connecting-ip"],
			},
			body,
		});
	};
	return { registry, post, connect, trigger: made.trigger };
}

async function started(response: Response): Promise<string> {
	expect(response.status, await response.clone().text()).toBe(202);
	const { runId } = (await response.json()) as { runId: string };
	expect(runId).toMatch(/^[0-9a-f-]{36}$/);
	return runId;
}

function phase(state: string, key: string) {
	return reports.find((report) => report.body.state === state && report.body.key === key)?.body;
}

function common(key: string, state: string) {
	return {
		kind: "run",
		key,
		title: "Hosted agent run",
		state,
		issue,
		executor: "agents-hosted",
		agent: agentName.slice(0, 64),
		sentAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
	};
}

it("reports the real webhook run to its issue, with exact bodies and monotonic phase times", async () => {
	const { registry, post, connect } = await setup("report-phases");
	const { sourceKey } = await connect();
	const id = "track-assignment";
	const runId = await started(await post({ id }));
	await vi.waitFor(() => expect(reports).toHaveLength(3));
	const run = await registry.getRun(runId);
	expect(run?.status).toBe("succeeded");
	for (const received of reports) {
		expect(received).toMatchObject({
			url: `${track}/api/events`,
			method: "POST",
			auth: `Bearer ${sourceKey}`,
			contentType: "application/json",
		});
	}
	const queued = phase("queued", runId);
	const running = phase("running", runId);
	const passed = phase("passed", runId);
	const startedAt = new Date(run?.startedAt ?? 0).toISOString();
	const endedAt = new Date(run?.endedAt ?? 0).toISOString();
	const url = `${origin}/report-phases/runs/${runId}`;
	expect(queued).toEqual(common(runId, "queued"));
	expect(running).toEqual({ ...common(runId, "running"), startedAt, url });
	expect(passed).toEqual({ ...common(runId, "passed"), startedAt, endedAt, url });
	expect(Date.parse(queued?.sentAt ?? "")).toBeLessThan(Date.parse(running?.sentAt ?? ""));
	expect(Date.parse(running?.sentAt ?? "")).toBeLessThan(Date.parse(passed?.sentAt ?? ""));
	expect(await (await post({ id })).json()).toEqual({ runId, duplicate: true });
	expect(reports).toHaveLength(3);
});

it("requires the signed event to match the pinned origin and exact approved workspace and team", async () => {
	const { registry, post, connect, trigger } = await setup("report-scope");
	await connect();
	await connect(otherTrack); // Identical Track workspace and team IDs on a different host.
	for (const options of [
		{ trackOrigin: otherTrack, issueKey: "OPS-1" },
		{ teamId: "other-team", issueKey: "OPS-2" },
		{ workspace: "other-workspace", issueKey: "OPS-3" },
		{ issueKey: "OTHER-4" },
	]) {
		const runId = await started(await post(options));
		await vi.waitFor(async () => expect((await registry.getRun(runId))?.status).toBe("succeeded"));
	}
	expect((await post({ valid: false })).status).toBe(401);
	expect(await (await post({ assignee: "someone-else" })).json()).toEqual({ skipped: true });
	expect(await (await post({ type: "issue.deleted" })).json()).toEqual({ skipped: true });
	await registry.updateTrigger(trigger.id, { active: false });
	expect(await (await post()).json()).toEqual({ skipped: true });
	expect(reports).toEqual([]);
});

it("deduplicates a pre-start refusal and gives the later real run a fresh ID", async () => {
	const { registry, post, connect } = await setup("report-refused", { key: false });
	await connect();
	const id = "provider-missing";
	expect((await post({ id })).status).toBe(409);
	await vi.waitFor(() => expect(reports).toHaveLength(2));
	const refused = reports.find(({ body }) => body.state === "failed")?.body;
	expect(refused).toEqual({
		...common(refused?.key ?? "", "failed"),
		progress: "Run could not start",
		waitDetail: "An admin needs to check the agent's model provider setup.",
	});
	expect((await post({ id })).status).toBe(409);
	expect(reports).toHaveLength(2);
	await registry.saveProviderKey({ provider: "anthropic", key: providerKey }, "Owner");
	const runId = await started(await post({ id }));
	expect(runId).not.toBe(refused?.key);
	await vi.waitFor(() => expect(phase("passed", runId)).toBeDefined());
	expect(reports).toHaveLength(5);
});

it("reports daily budget and repository mapping refusals with their actionable Track reasons", async () => {
	const ready = await setup("report-daily");
	await ready.connect();
	await ready.registry.updateTrigger(ready.trigger.id, { perDay: 1 });
	const runId = await started(await ready.post({ issueKey: "OPS-1" }));
	await vi.waitFor(() => expect(phase("passed", runId)).toBeDefined());
	const id = "over-daily-limit";
	const limited = await ready.post({ id });
	expect(limited.status).toBe(429);
	expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
	await vi.waitFor(() => expect(reports).toHaveLength(4));
	const blocked = reports.find(({ body }) => body.state === "failed")?.body;
	expect(blocked).toEqual({
		...common(blocked?.key ?? "", "failed"),
		progress: "Run could not start",
		waitReason: "budget-limit",
		waitDetail: "The trigger started its 1 run for the day",
	});
	expect((await ready.post({ id })).status).toBe(429);

	const unmapped = await setup("report-mapping", { sandbox: true });
	await unmapped.connect();
	expect((await unmapped.post()).status).toBe(409);
	await vi.waitFor(() => expect(reports).toHaveLength(6));
	const mapping = reports.find(({ body }) => body.waitReason === "needs-mapping")?.body;
	expect(mapping).toEqual({
		...common(mapping?.key ?? "", "failed"),
		progress: "Run could not start",
		waitReason: "needs-mapping",
		waitDetail: "An admin needs to check the agent's repository setup.",
	});
});

it("reports which model budget limit refused a run", async () => {
	const ready = await setup("report-model-cap");
	await ready.connect();
	await ready.registry.setModelKeyCaps({ daily: "0", monthly: "" });
	const limited = await ready.post({ id: "model-cap-refusal" });
	expect(limited.status).toBe(409);
	await vi.waitFor(() => expect(reports).toHaveLength(2));
	const blocked = reports.find(({ body }) => body.state === "failed")?.body;
	expect(blocked).toEqual({
		...common(blocked?.key ?? "", "failed"),
		progress: "Run could not start",
		waitReason: "budget-limit",
		waitDetail: "The workspace's model-key daily cap was reached. Retry when the day resets.",
	});
});

it("keeps the webhook and run independent of a delayed, redirecting Track endpoint", async () => {
	const { registry, post, connect } = await setup("report-unavailable");
	await connect();
	const redirect = `${otherTrack}/unexpected`;
	const release = Promise.withResolvers<void>();
	const returned = Promise.withResolvers<void>();
	const followed = Promise.withResolvers<boolean>();
	let redirects = 0;
	answerReport = async ({ url }) => {
		if (url === redirect) {
			followed.resolve(true);
			return new Response(null, { status: 202 });
		}
		await release.promise;
		if (++redirects === 3) returned.resolve();
		return Response.redirect(redirect, 307);
	};
	try {
		const runId = await started(await post());
		await vi.waitFor(async () => expect((await registry.getRun(runId))?.status).toBe("succeeded"));
		await vi.waitFor(() => expect(reports).toHaveLength(3));
	} finally {
		release.resolve();
	}
	await returned.promise;
	// Observe the outbound requests through the sender's five-second timeout.
	expect(await Promise.race([followed.promise, setTimeout(5_200, false)])).toBe(false);
	expect(agents.outbound).not.toContain(redirect);
}, 15_000);

it("maps an authoritative stop and ignores a disconnected destination even after replacement", async () => {
	const { registry, post, connect } = await setup("report-stop");
	const { destinationId } = await connect();
	const stream = Promise.withResolvers<void>();
	models.script = () =>
		new Response(
			new ReadableStream({
				async start(controller) {
					await stream.promise;
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	const finish = {
		status: "stopped" as const,
		error: "A private error",
		steps: 0,
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cost: null,
		endedAt: Date.now(),
	};
	try {
		const runId = await started(await post());
		await vi.waitFor(() => expect(phase("running", runId)).toBeDefined());
		expect(await registry.finishRun(runId, { ...finish, endedAt: Date.now() })).toBe(true);
		await vi.waitFor(() => expect(phase("cancelled", runId)).toBeDefined());
		const running = phase("running", runId);
		expect(phase("cancelled", runId)).toEqual({
			...common(runId, "cancelled"),
			startedAt: running?.startedAt,
			url: running?.url,
			endedAt: expect.any(String),
		});
		expect(await registry.finishRun(runId, finish)).toBe(false);

		const second = await started(await post({ issueKey: "OPS-2" }));
		await vi.waitFor(() => expect(phase("running", second)).toBeDefined());
		expect(await registry.removeTrackSource(destinationId)).toBe(true);
		await connect();
		expect(await registry.finishRun(second, { ...finish, endedAt: Date.now() })).toBe(true);
		expect(reports).toHaveLength(5);
	} finally {
		stream.resolve();
	}
});
