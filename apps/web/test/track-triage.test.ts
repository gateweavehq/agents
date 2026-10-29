import { createHmac, randomBytes } from "node:crypto";
import { TRACK_TRIAGE_TOOLS } from "@gateweave/agents-model";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type RegistryStub, startAgents } from "./agents-worker";
import { FakeMcpServer, type FakeTool } from "./fake-mcp";
import { anthropicToolCall, FakeModels } from "./fake-models";

const origin = "https://agents.test";
const KEY = "sk-ant-api03-correct-horse-battery";
const AGENT_KEY = `gwt_${"t".repeat(43)}`;

// Everything Track's MCP server offers an agent member, of which triage needs five.
const TRACK_TOOLS: FakeTool[] = [
	"list_workspaces",
	"get_workspace",
	"search_issues",
	"get_issue",
	"create_issue",
	"update_issue",
	"add_comment",
	"create_label",
	"create_team",
].map((name) => ({
	name,
	description: `Track's ${name}`,
	inputSchema: { type: "object", properties: {} },
}));
const track = new FakeMcpServer(TRACK_TOOLS, (name) => ({
	content: [{ type: "text", text: name === "get_issue" ? '{"key":"TRK-7"}' : "{}" }],
}));

const models = new FakeModels({ [KEY]: { provider: "anthropic", models: ["claude-haiku-5-5"] } });
// The agent reads the issue once, then answers.
models.script = (body) =>
	body.tools?.some((tool) => tool.name === "track__get_issue") &&
	!JSON.stringify(body.messages).includes("tool_result")
		? anthropicToolCall("track__get_issue", { key: "TRK-7" })
		: undefined;

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { models, hosts: { "track.test": track.handle } });
});

afterAll(async () => {
	await agents?.dispose();
});

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	return (await response.text()).replaceAll("<!-- -->", "");
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

/** An issue.created event as Track's webhooks send it, signed with the webhook's secret. */
function deliver(url: string, secret: string) {
	const body = JSON.stringify({
		type: "issue.created",
		timestamp: new Date().toISOString(),
		data: {
			workspace: { id: "ws_1", slug: "acme" },
			version: 12,
			actor: { id: "u_1", name: "Maya", type: "user" },
			issue: {
				id: "i_7",
				key: "TRK-7",
				title: "Login fails on Safari",
				description: "The button does nothing.",
				url: "https://track.test/acme/issue/TRK-7",
			},
		},
	});
	const id = crypto.randomUUID();
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
			"webhook-signature": `v1,${mac}`,
		},
		body,
	});
}

it("triages each new Track issue with the agent member's key and only triage's tools", async () => {
	const owner = await signUp(agents, origin, "ada-triage");
	const workspaceId = await createWorkspace(agents, origin, owner.headers, "triage");
	const registry = await agents.registry(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");

	// Owners and admins find it among the ready-made agents.
	expect(await page("/triage/agents", owner.headers.cookie)).toContain("Triage Track issues");

	const made = await registry.setUpTrackTriage(
		{
			trackUrl: "https://track.test",
			agentKey: AGENT_KEY,
			provider: "anthropic",
			model: "claude-haiku-5-5",
			instructions: "Triage each new issue.\n",
		},
		owner.userId,
		"Ada",
	);
	if ("status" in made) throw new Error(made.message);
	// Track makes the webhook's secret, and the trigger takes it.
	const secret = `whsec_${randomBytes(32).toString("base64")}`;
	expect(await registry.replaceTriggerSecret(made.trigger.id, secret)).toMatchObject({ secret });

	const url = `${origin}/api/triggers/${workspaceId}/${made.trigger.id}`;
	const response = await deliver(url, secret);
	expect(response.status).toBe(202);
	const { runId } = (await response.json()) as { runId: string };
	expect(await settled(registry, runId)).toMatchObject({
		status: "succeeded",
		triggerName: "New issues",
	});

	// The model reads the issue as the prompt says it, with the triage instructions, and is
	// offered triage's tools only.
	const asked = models.requests.find((request) => request.body.includes("TRK-7"));
	const body = JSON.parse(asked?.body ?? "{}") as { system?: unknown; tools?: { name: string }[] };
	expect(JSON.stringify(body)).toContain(
		'A new issue was opened in the Track workspace \\"acme\\": TRK-7, \\"Login fails on Safari\\". Triage it.',
	);
	expect(JSON.stringify(body.system)).toContain("Triage each new issue.");
	expect(body.tools?.map((tool) => tool.name).sort()).toEqual(
		TRACK_TRIAGE_TOOLS.map((tool) => `track__${tool}`).sort(),
	);

	// Track is reached as the agent member, with the key from the agent's environment set.
	expect(track.requests.length).toBeGreaterThan(0);
	for (const request of track.requests) {
		expect(request.headers.get("authorization")).toBe(`Bearer ${AGENT_KEY}`);
	}
	expect(track.requests.find((request) => request.method === "tools/call")?.params).toEqual({
		name: "get_issue",
		arguments: { key: "TRK-7" },
	});

	// The agent's page shows where its trigger listens, and never the key.
	const agent = await page(`/triage/agents/${made.agent.id}`, owner.headers.cookie);
	expect(agent).toContain("New issues");
	expect(agent).toContain(url);
	expect(agent).toContain("https://track.test/mcp");
	expect(agent).not.toContain(AGENT_KEY);
});

it("offers the ready-made agents to owners and admins only", async () => {
	const owner = await signUp(agents, origin, "ada-ready");
	const workspaceId = await createWorkspace(agents, origin, owner.headers, "ready");
	const { userId: grace, headers } = await signUp(agents, origin, "grace-ready");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace, Date.now())
		.run();
	expect(await page("/ready/agents", owner.headers.cookie)).toContain("Triage Track issues");
	expect(await page("/ready/agents", headers.cookie)).not.toContain("Triage Track issues");
});
