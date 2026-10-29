import { createHmac } from "node:crypto";
import type { TriggerInput } from "@gateweave/agents-model";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type RegistryStub, startAgents } from "./agents-worker";
import { FakeModels } from "./fake-models";

const origin = "https://agents.test";
const KEY = "sk-ant-api03-correct-horse-battery";
const EVENT = JSON.stringify({ type: "issue.created", data: { title: "Login fails" } });

const models = new FakeModels({ [KEY]: { provider: "anthropic", models: ["claude-sonnet-5-5"] } });

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { models });
});

afterAll(async () => {
	await agents?.dispose();
});

/** A workspace with an agent, Triager, a key for its provider, and a trigger for Triager. */
async function workspace(slug: string, trigger: Partial<TriggerInput> = {}) {
	const owner = await signUp(agents, origin, `ada-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const agent = await registry.createAgent({
		name: "Triager",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const made = await registry.createTrigger(
		{
			name: "New issues",
			prompt: "Triage this issue: {{data.title}}",
			target: { kind: "agent", agentId: agent.id },
			...trigger,
		},
		owner.userId,
	);
	if ("status" in made) throw new Error(made.message);
	const url = `${origin}/api/triggers/${workspaceId}/${made.trigger.id}`;
	return { owner, workspaceId, registry, agentId: agent.id, url, ...made };
}

/** Posts an event to a trigger as a Standard Webhooks sender does, signed with `secret`. */
function post(
	url: string,
	secret: string,
	{ id = crypto.randomUUID(), body = EVENT, signature = "" } = {},
) {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const mac = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64");
	return agents.fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": signature || `v1,${mac}`,
		},
		body,
	});
}

/** The run once the runtime has reported how it ended, which comes after the gateway answers. */
async function settled(registry: RegistryStub, runId: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const run = await registry.getRun(runId);
		if (run && run.status !== "running") return run;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("The run did not end");
}

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments.
	return (await response.text()).replaceAll("<!-- -->", "");
}

it("starts a run of the agent for each signed event, once", async () => {
	const { owner, registry, url, trigger, secret, agentId } = await workspace("triggers-forge");
	const id = crypto.randomUUID();
	const response = await post(url, secret, { id });
	expect(response.status).toBe(202);
	const { runId } = (await response.json()) as { runId: string };
	expect(await settled(registry, runId)).toMatchObject({
		status: "succeeded",
		startedBy: `trigger:${trigger.id}`,
		triggerName: "New issues",
	});
	const sent = models.requests.find((request) => request.body.includes("Login fails"));
	expect(sent?.body).toContain("Triage this issue: Login fails");

	// The sender retries the event: it is answered, and starts nothing more.
	const retry = await post(url, secret, { id });
	expect(retry.status).toBe(202);
	expect(await retry.json()).toEqual({ runId, duplicate: true });
	expect(await registry.listRuns()).toHaveLength(1);

	// The owner reads the run's conversation on its page, and manages the trigger on the agent's.
	const run = await page(`/triggers-forge/runs/${runId}`, owner.headers.cookie);
	expect(run).toContain("Started by New issues (trigger)");
	expect(run).toContain("Triage this issue: Login fails");
	expect(run).toContain(models.reply);
	expect(run).not.toContain("Open the conversation");
	const agent = await page(`/triggers-forge/agents/${agentId}`, owner.headers.cookie);
	expect(agent).toContain("New issues");
	expect(agent).toContain(url);
	expect(agent).not.toContain(secret);
});

it("turns away events that are not signed with the secret, or not for a trigger", async () => {
	const { workspaceId, registry, url, secret } = await workspace("triggers-gate");
	const unsigned = await agents.fetch(url, { method: "POST", body: EVENT });
	expect(unsigned.status).toBe(401);
	const forged = await post(url, secret, { signature: "v1,bm9wZQ==" });
	expect(forged.status).toBe(401);
	const wrong = await post(
		url,
		`whsec_${Buffer.from("another secret, 32 bytes long!!").toString("base64")}`,
	);
	expect(wrong.status).toBe(401);

	const missing = await post(`${origin}/api/triggers/${workspaceId}/no-such-trigger`, secret);
	expect(missing.status).toBe(404);
	const nowhere = await post(url.replace(workspaceId, crypto.randomUUID()), secret);
	expect(nowhere.status).toBe(404);
	const large = await post(url, secret, {
		body: JSON.stringify({ type: "big", data: "x".repeat(70_000) }),
	});
	expect(large.status).toBe(413);

	expect(await registry.listRuns()).toEqual([]);
	const [listed] = await registry.listTriggers();
	expect(listed?.deliveries).toEqual([]);
});

it("holds a trigger to its runs a day, telling the sender when to try again", async () => {
	const { registry, url, secret } = await workspace("triggers-cap", { perDay: 1 });
	const first = await post(url, secret);
	expect(first.status).toBe(202);
	const over = await post(url, secret);
	expect(over.status).toBe(429);
	expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(23 * 60 * 60);
	expect(await over.json()).toEqual({ error: "The trigger started its 1 runs for the day" });

	// Paused, it takes events and starts nothing.
	const [trigger] = await registry.listTriggers();
	await registry.updateTrigger(trigger?.id ?? "", { active: false });
	const paused = await post(url, secret);
	expect(paused.status).toBe(202);
	expect(await paused.json()).toEqual({ skipped: true });
	expect(await registry.listRuns()).toHaveLength(1);
});

it("starts the lead of a team, with the team's edges", async () => {
	const { owner, workspaceId, registry, agentId } = await workspace("triggers-team");
	const coder = await registry.createAgent({
		name: "Coder",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	const team = await registry.createTeam({ name: "Builders", description: null, lead: agentId });
	await registry.setTeamGraph(team.id, {
		lead: agentId,
		members: [
			{ kind: "agent", id: agentId },
			{ kind: "agent", id: coder.id },
		],
		edges: [{ from: agentId, to: coder.id, kind: "delegate" }],
	});
	const made = await registry.createTrigger(
		{ name: "Releases", prompt: "Plan the release", target: { kind: "team", teamId: team.id } },
		owner.userId,
	);
	if ("status" in made) throw new Error(made.message);

	const response = await post(
		`${origin}/api/triggers/${workspaceId}/${made.trigger.id}`,
		made.secret,
	);
	expect(response.status).toBe(202);
	const { runId } = (await response.json()) as { runId: string };
	expect(await settled(registry, runId)).toMatchObject({
		agentName: "Triager",
		teamPath: [team.id],
		triggerName: "Releases",
	});
	const sent = models.requests.find((request) => request.body.includes("Plan the release"));
	expect(sent?.body).toContain("delegate");
});
