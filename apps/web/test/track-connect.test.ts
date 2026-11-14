import { createHmac, randomBytes } from "node:crypto";
import { assigneeSkip } from "@gateweave/agents-model";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type RegistryStub, startAgents } from "./agents-worker";
import { FakeModels } from "./fake-models";
import { FakeTrack } from "./fake-track";
import { callServerFn } from "./server-fn";

// Connecting Track in one step (AGT-119): the Worker's half against a stand-in for Track's
// approval page, exchange and undo, as built in gateweavehq/track#306.

const origin = "https://agents.test";
const KEY = "sk-ant-api03-correct-horse-battery";

const track = new FakeTrack("https://track.test");
const models = new FakeModels({
	[KEY]: { provider: "anthropic", models: ["claude-sonnet-5-5", "claude-haiku-5-5"] },
});

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, {
		models,
		hosts: { "track.test": track.handle },
		// Offers sandboxes; no test here runs one.
		settings: { SANDBOX: "1" },
	});
});

afterAll(async () => {
	await agents?.dispose();
});

type Person = Awaited<ReturnType<typeof signUp>>;

/** Everything the Worker answered, for checking that no secret is in any of it. */
const seen: string[] = [];

let counter = 0;

/** A workspace with an Anthropic key and a repository the GitHub App reaches, and its owner. */
async function workspace() {
	const label = `track-${++counter}`;
	const owner = await signUp(agents, origin, `ada-${label}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, label);
	const registry = await agents.registry(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = ""] = await registry.syncRepositories([
		{
			provider: "github",
			externalId: `${counter}`,
			installationId: "99",
			owner: "acme",
			name: "site",
			defaultBranch: "main",
			private: true,
		},
	]);
	return { owner, slug: label, workspaceId, registry, repositoryId };
}

async function addMember(workspaceId: string, name: string, role: "admin" | "member") {
	const person = await signUp(agents, origin, `${name}-${++counter}`);
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, person.userId, role, Date.now())
		.run();
	return person;
}

const WORK = (repositoryId: string) => ({
	purpose: "work",
	trackUrl: "https://track.test/acme",
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	engine: "claude-code",
	repositoryId,
});
const TRIAGE = {
	purpose: "triage",
	trackUrl: "https://track.test",
	provider: "anthropic",
	model: "claude-haiku-5-5",
};

/** Presses "Connect Track": what the page's server function answers. */
async function start(who: Person, slug: string, connect: Record<string, string>) {
	const call = await callServerFn(agents, origin, "beginTrackConnect", {
		data: { slug, connect },
		cookie: who.headers.cookie,
		client: who.headers["cf-connecting-ip"],
	});
	seen.push(call.text);
	const address = /https:\/\/track\.test\/connect\/agent[^"\\]*/.exec(call.text)?.[0];
	return { ...call, address };
}

/** The browser arrives back at the app, as Track sent it. */
async function arrive(who: Person, location: string) {
	const response = await agents.fetch(location, { headers: { cookie: who.headers.cookie } });
	const body = await response.text();
	seen.push(body, response.headers.get("location") ?? "");
	return { response, body, location: response.headers.get("location") ?? "" };
}

/** Everything the workspace holds that connecting makes. */
async function holdings(registry: RegistryStub) {
	return {
		agents: (await registry.overview()).agents,
		triggers: (await registry.listTriggers()).length,
		envSets: (await registry.listEnvSets()).length,
		servers: (await registry.listMcpServers()).length,
		library: (await registry.listLibrary()).length,
	};
}
const NOTHING = { agents: 0, triggers: 0, envSets: 0, servers: 0, library: 0 };

async function auditRows(workspaceId: string) {
	const { results } = await agents.db
		.prepare("select * from audit_event where organization_id = ? order by id")
		.bind(workspaceId)
		.all();
	return results as { action: string; target_id: string | null; detail: string }[];
}

function signed(secret: string, body: string) {
	const id = crypto.randomUUID();
	const timestamp = String(Math.floor(Date.now() / 1000));
	const mac = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64");
	return {
		"content-type": "application/json",
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": `v1,${mac}`,
	};
}

/** An issue event as Track's webhooks send it. */
function issueEvent(type: string, assigneeId: string | null) {
	return JSON.stringify({
		type,
		timestamp: new Date().toISOString(),
		data: {
			workspace: { id: "w_acme", slug: "acme" },
			version: 12,
			actor: { id: "u_1", name: "Maya", type: "person" },
			issue: {
				id: "i_7",
				key: "TRK-7",
				title: "Login fails on Safari",
				description: "The button does nothing.",
				assigneeId,
			},
		},
	});
}

/** Nothing the app showed or logged holds what only the servers may know. */
async function expectNothingSecret(workspaceId: string) {
	const rows = JSON.stringify(await auditRows(workspaceId));
	const everywhere = [...seen, rows, ...agents.logs.map((log) => log.message)].join("\n");
	for (const made of track.issued) {
		for (const secret of [made.agentKey, made.webhookSecret, made.undo]) {
			expect(everywhere).not.toContain(secret);
		}
	}
	for (const { verifier } of track.exchanges) expect(everywhere).not.toContain(verifier);
}

it("connects Track for work in one step, with no key or secret typed, shown or copied", async () => {
	const { owner, slug, workspaceId, registry, repositoryId } = await workspace();
	const begun = await start(owner, slug, WORK(repositoryId));
	if (!begun.address) throw new Error(begun.text);

	// What Track is told: one origin for the webhook and the way back, the events work needs.
	const asked = new URL(begun.address).searchParams;
	expect(asked.get("purpose")).toBe("work");
	expect(asked.get("events")).toBe("issue.created,issue.updated,comment.created");
	const webhook = new URL(asked.get("webhook") ?? "");
	expect(webhook.origin).toBe(origin);
	expect(new URL(asked.get("return") ?? "").origin).toBe(origin);
	expect(webhook.pathname.startsWith(`/api/triggers/${workspaceId}/`)).toBe(true);
	const triggerId = webhook.pathname.split("/").pop() ?? "";
	// Nothing is made before the person has approved.
	expect(await holdings(registry)).toEqual(NOTHING);

	const { response, location } = await arrive(owner, track.approve(begun.address));
	expect(response.status).toBe(302);
	const landed = new URL(location, origin);
	expect(landed.pathname).toMatch(new RegExp(`^/${slug}/agents/[^/]+$`));
	expect(landed.searchParams.get("trackConnected")).toBe("work");
	expect(landed.searchParams.get("workspaceName")).toBe("ACME");

	const made = track.issued[0];
	if (!made) throw new Error("Track made nothing");
	expect(track.exchanges).toHaveLength(1);
	// Agent, environment set, MCP server and trigger, all there.
	expect(await holdings(registry)).toMatchObject({
		agents: 1,
		triggers: 1,
		envSets: 1,
		servers: 1,
	});
	const [trigger] = await registry.listTriggers();
	// The id the webhook's URL named, and the id Track puts in `issue.assigneeId`.
	expect(trigger).toMatchObject({
		id: triggerId,
		name: "Assigned issues",
		assignee: made.agentId,
		perIssue: true,
		events: ["issue.created", "issue.updated", "comment.created"],
	});
	expect(
		landed.pathname.endsWith(trigger?.target.kind === "agent" ? trigger.target.agentId : "-"),
	).toBe(true);
	expect(assigneeSkip(made.agentId, issueEvent("issue.created", made.agentId))).toBeNull();
	expect(assigneeSkip(made.agentId, issueEvent("issue.created", "someone-else"))).not.toBeNull();

	// A delivery signed with the secret Track made is accepted; with any other it is refused.
	const url = `${origin}/api/triggers/${workspaceId}/${triggerId}`;
	const body = issueEvent("issue.created", "someone-else");
	const accepted = await agents.fetch(url, {
		method: "POST",
		headers: signed(made.webhookSecret, body),
		body,
	});
	expect(accepted.status).toBe(202);
	expect(await accepted.json()).toEqual({ skipped: true });
	const other = `whsec_${randomBytes(24).toString("base64")}`;
	expect(
		(await agents.fetch(url, { method: "POST", headers: signed(other, body), body })).status,
	).toBe(401);

	// The key is the environment set's secret, never shown; Track is checked with it.
	const authorized = track.mcp.requests.map((request) => request.headers.get("authorization"));
	expect(authorized.length).toBeGreaterThan(0);
	for (const header of authorized) expect(header).toBe(`Bearer ${made.agentKey}`);

	// Audited as the setup is, and as a connection, with Track's origin, workspace and agent.
	const rows = await auditRows(workspaceId);
	expect(rows.map((row) => row.action)).toEqual(
		expect.arrayContaining(["trackWork.setUp", "track.connected"]),
	);
	const connected = rows.find((row) => row.action === "track.connected");
	expect(JSON.parse(connected?.detail ?? "{}")).toEqual({
		origin: "https://track.test",
		workspace: "acme",
		trackAgent: made.agentId,
	});

	// The same approval cannot be used again.
	const replay = await arrive(owner, track.approve(begun.address));
	expect(replay.response.status).toBe(400);
	expect(track.exchanges).toHaveLength(1);
	expect(await holdings(registry)).toMatchObject({ agents: 1, triggers: 1 });
	await expectNothingSecret(workspaceId);
});

it("connects Track for triage, and a delivery signed with Track's secret starts a run", async () => {
	const { owner, slug, workspaceId, registry } = await workspace();
	const begun = await start(owner, slug, TRIAGE);
	if (!begun.address) throw new Error(begun.text);
	expect(new URL(begun.address).searchParams.get("events")).toBe("issue.created");
	const triggerId = new URL(new URL(begun.address).searchParams.get("webhook") ?? "").pathname
		.split("/")
		.pop();

	const { response, location } = await arrive(
		owner,
		track.approve(begun.address, { name: "Sorter" }),
	);
	expect(response.status).toBe(302);
	expect(new URL(location, origin).searchParams.get("trackConnected")).toBe("triage");
	const made = track.issued.at(-1);
	if (!made) throw new Error("Track made nothing");
	const [trigger] = await registry.listTriggers();
	expect(trigger).toMatchObject({
		id: triggerId,
		name: "New issues",
		assignee: null,
		events: ["issue.created"],
	});
	// The agent has the name Track gave its member.
	expect((await registry.overview()).agents).toBe(1);

	const url = `${origin}/api/triggers/${workspaceId}/${triggerId}`;
	const body = issueEvent("issue.created", null);
	const accepted = await agents.fetch(url, {
		method: "POST",
		headers: signed(made.webhookSecret, body),
		body,
	});
	expect(accepted.status).toBe(202);
	const { runId } = (await accepted.json()) as { runId: string };
	expect(runId).toBeTruthy();
	const other = `whsec_${randomBytes(24).toString("base64")}`;
	expect(
		(await agents.fetch(url, { method: "POST", headers: signed(other, body), body })).status,
	).toBe(401);
	for (let attempt = 0; attempt < 100; attempt++) {
		const run = await registry.getRun(runId);
		if (run && run.status !== "running") break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await expectNothingSecret(workspaceId);
});

it("keeps the state for the person who started it, once", async () => {
	const { owner, slug, workspaceId, registry } = await workspace();
	const other = await addMember(workspaceId, "grace", "admin");
	const begun = await start(owner, slug, TRIAGE);
	if (!begun.address) throw new Error(begun.text);
	const back = track.approve(begun.address);
	const before = track.exchanges.length;

	// Another admin of the same workspace, with the same address, makes nothing and asks Track nothing.
	const stranger = await arrive(other, back);
	expect(stranger.response.status).toBe(400);
	expect(track.exchanges).toHaveLength(before);
	expect(await holdings(registry)).toEqual(NOTHING);

	// And the state is spent: not even the person it was for can use it now.
	const owned = await arrive(owner, back);
	expect(owned.response.status).toBe(400);
	expect(track.exchanges).toHaveLength(before);
	expect(await holdings(registry)).toEqual(NOTHING);
	await expectNothingSecret(workspaceId);
});

it("does not finish for someone who is no longer an admin, or never was a member", async () => {
	const { slug, workspaceId, registry, owner } = await workspace();
	const grace = await addMember(workspaceId, "grace", "admin");
	const begun = await start(grace, slug, TRIAGE);
	if (!begun.address) throw new Error(begun.text);
	const back = track.approve(begun.address);
	await agents.db
		.prepare("UPDATE member SET role = 'member' WHERE organization_id = ? AND user_id = ?")
		.bind(workspaceId, grace.userId)
		.run();
	const before = track.exchanges.length;
	const demoted = await arrive(grace, back);
	expect(demoted.response.status).toBe(403);
	expect(track.exchanges).toHaveLength(before);

	const outsider = await signUp(agents, origin, `outsider-${++counter}`);
	const fresh = await start(owner, slug, TRIAGE);
	if (!fresh.address) throw new Error(fresh.text);
	expect((await arrive(outsider, track.approve(fresh.address))).response.status).toBe(404);
	expect(track.exchanges).toHaveLength(before);
	expect(await holdings(registry)).toEqual(NOTHING);

	// A plain member cannot start one.
	const member = await addMember(workspaceId, "mo", "member");
	expect((await start(member, slug, TRIAGE)).failed).toBe(true);
});

it("sends a signed-out browser to sign in before it asks Track anything", async () => {
	const { owner, slug } = await workspace();
	const begun = await start(owner, slug, TRIAGE);
	if (!begun.address) throw new Error(begun.text);
	const before = track.exchanges.length;
	const response = await agents.fetch(track.approve(begun.address));
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).toMatch(/^\/login\?redirect=/);
	expect(track.exchanges).toHaveLength(before);
});

it("makes nothing and calls nothing when the person says no in Track", async () => {
	const { owner, slug, registry } = await workspace();
	const begun = await start(owner, slug, TRIAGE);
	if (!begun.address) throw new Error(begun.text);
	const before = { exchanges: track.exchanges.length, undos: track.undos.length };
	const { response, location } = await arrive(owner, track.deny(begun.address));
	expect(response.status).toBe(302);
	expect(location).toBe(`/${slug}/agents?trackConnect=denied`);
	expect(track.exchanges).toHaveLength(before.exchanges);
	expect(track.undos).toHaveLength(before.undos);
	expect(await holdings(registry)).toEqual(NOTHING);
});

it("makes nothing when Track does not accept the code", async () => {
	const { owner, slug, registry } = await workspace();
	const begun = await start(owner, slug, TRIAGE);
	if (!begun.address) throw new Error(begun.text);
	const undos = track.undos.length;
	track.exchangeMode = "invalid_code";
	try {
		const { response, location } = await arrive(owner, track.approve(begun.address));
		expect(response.status).toBe(302);
		expect(location).toBe(`/${slug}/agents?trackConnect=expired`);
	} finally {
		track.exchangeMode = "ok";
	}
	expect(track.undos).toHaveLength(undos);
	expect(await holdings(registry)).toEqual(NOTHING);
});

it("asks Track to undo what it made when the key does not check out, and leaves nothing", async () => {
	const { owner, slug, workspaceId, registry, repositoryId } = await workspace();
	const begun = await start(owner, slug, WORK(repositoryId));
	if (!begun.address) throw new Error(begun.text);
	const undos = track.undos.length;
	// Track names the member one way over MCP and another in the answer: no run would ever start.
	track.youId = "someone-else";
	try {
		const { response, body } = await arrive(owner, track.approve(begun.address));
		expect(response.status).toBe(500);
		expect(body).toContain("Nothing was left behind");
	} finally {
		track.youId = null;
	}
	const made = track.issued.at(-1);
	expect(track.undos.slice(undos)).toEqual([made?.undo]);
	expect(await holdings(registry)).toEqual(NOTHING);
	expect(await registry.listTriggers()).toEqual([]);
	await expectNothingSecret(workspaceId);
});

it("asks Track to undo when the registry will not take the agent, and leaves nothing", async () => {
	const { owner, slug, workspaceId, registry, repositoryId } = await workspace();
	const begun = await start(owner, slug, WORK(repositoryId));
	if (!begun.address) throw new Error(begun.text);
	const back = track.approve(begun.address);
	// While the person is in Track, the workspace fills up with triggers: the one write refuses.
	const filler = await registry.createAgent({
		name: "Filler",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	for (let n = 0; n < 50; n++) {
		const made = await registry.createTrigger(
			{ name: `Filler ${n}`, prompt: "x", target: { kind: "agent", agentId: filler.id } },
			owner.userId,
		);
		if ("status" in made) throw new Error(made.message);
	}
	const held = await holdings(registry);
	const undos = track.undos.length;
	const { response, body } = await arrive(owner, back);
	expect(response.status).toBe(500);
	expect(body).toContain("up to 50 triggers");
	expect(body).toContain("Nothing was left behind");
	expect(track.undos).toHaveLength(undos + 1);
	// Not an agent, an environment set, an MCP server, a library asset or a trigger more.
	expect(await holdings(registry)).toEqual(held);
	await expectNothingSecret(workspaceId);
});

it("asks Track to undo an answer it cannot use, with the token the answer carried", async () => {
	const { owner, slug, registry } = await workspace();
	const begun = await start(owner, slug, TRIAGE);
	if (!begun.address) throw new Error(begun.text);
	const undos = track.undos.length;
	track.exchangeMode = "unusable";
	try {
		const { response, location } = await arrive(owner, track.approve(begun.address));
		expect(response.status).toBe(302);
		expect(location).toBe(`/${slug}/agents?trackConnect=failed`);
	} finally {
		track.exchangeMode = "ok";
	}
	expect(track.undos.slice(undos)).toEqual([track.issued.at(-1)?.undo]);
	expect(await holdings(registry)).toEqual(NOTHING);
});

it("says exactly what is left in Track when the undo fails too, without a secret", async () => {
	const { owner, slug, workspaceId, registry, repositoryId } = await workspace();
	const begun = await start(owner, slug, WORK(repositoryId));
	if (!begun.address) throw new Error(begun.text);
	const back = track.approve(begun.address, { name: "Sorter" });
	const undos = track.undos.length;
	// The setup fails after the exchange, and Track cannot take its work back either.
	track.youId = "someone-else";
	track.undoMode = "try_again";
	try {
		const { response, body } = await arrive(owner, back);
		expect(response.status).toBe(500);
		// It names what is left, and where to remove it.
		expect(body).toContain("may still be there on track.test");
		expect(body).toContain("agent member Sorter");
		expect(body).toContain("workspace ACME (acme)");
		expect(body).toContain("Settings");
		expect(body).not.toContain("Nothing was left behind");
	} finally {
		track.youId = null;
		track.undoMode = "ok";
	}
	// Asked three times, as a 500 that is safe to repeat is.
	expect(track.undos.slice(undos)).toHaveLength(3);
	expect(await holdings(registry)).toEqual(NOTHING);
	await expectNothingSecret(workspaceId);
});

it("refuses before leaving for a provider with no key or a repository the app does not reach", async () => {
	const { owner, slug, repositoryId, registry } = await workspace();
	const noKey = await start(owner, slug, { ...TRIAGE, provider: "openai", model: "gpt-5.5" });
	expect(noKey.failed).toBe(true);
	expect(noKey.text).toContain("no OpenAI key");
	const noRepository = await start(owner, slug, { ...WORK(repositoryId), repositoryId: "nope" });
	expect(noRepository.failed).toBe(true);
	expect(noRepository.text).toContain("no such repository");
	const wrongEngine = await start(owner, slug, { ...WORK(repositoryId), engine: "codex" });
	expect(wrongEngine.failed).toBe(true);
	expect(wrongEngine.address).toBeUndefined();
	// Nothing was kept for any of them.
	expect(await holdings(registry)).toEqual(NOTHING);
});
