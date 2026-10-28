import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type RegistryStub, startAgents } from "./agents-worker";
import { ask } from "./chat-socket";
import { anthropicToolCall, FakeModels } from "./fake-models";

const origin = "https://agents.test";
const KEY = "sk-ant-api03-correct-horse-battery";

const models = new FakeModels({ [KEY]: { provider: "anthropic", models: ["claude-sonnet-5-5"] } });
// The lead hands the task to Coder once, then answers; Coder answers at once.
models.script = (body) =>
	body.tools?.some((tool) => tool.name === "delegate__Coder") &&
	!JSON.stringify(body.messages).includes("tool_result")
		? anthropicToolCall("delegate__Coder", { task: "Write the login form" })
		: undefined;

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { models });
});

afterAll(async () => {
	await agents?.dispose();
});

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments.
	return (await response.text()).replaceAll("<!-- -->", "");
}

/** The run of the person's message, once it and the runs it led to have all ended. */
async function settled(registry: RegistryStub) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const [root] = await registry.listRuns();
		if (root && root.status !== "running" && root.total.running === 0) return root;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("The runs did not end");
}

it("runs a team's delegation as a nested run, linked both ways, with no route of its own", async () => {
	const owner = await signUp(agents, origin, "ada-team-turns");
	const workspaceId = await createWorkspace(agents, origin, owner.headers, "team-forge");
	const registry = await agents.registry(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const agent = async (name: string) =>
		(
			await registry.createAgent({
				name,
				description: null,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: null,
			})
		).id;
	const planner = await agent("Planner");
	const coder = await agent("Coder");
	const team = await registry.createTeam({ name: "Builders", description: null, lead: planner });
	await registry.setTeamGraph(team.id, {
		lead: planner,
		members: [
			{ kind: "agent", id: planner },
			{ kind: "agent", id: coder },
		],
		edges: [{ from: planner, to: coder, kind: "delegate" }],
	});
	const cookie = owner.headers.cookie;
	// The team is there to chat with, beside its agents.
	const start = await page("/team-forge/chat", cookie);
	expect(start).toContain("Teams");
	expect(start).toContain("Builders");
	expect(start).toContain("Led by Planner");

	const conversation = await registry.startTeamConversation(team.id, owner.userId);
	if (!conversation) throw new Error("The conversation did not start");

	const { socket } = await agents.connect(`${origin}/api/chat/team-forge/${conversation.id}`, {
		cookie,
		origin,
	});
	if (!socket) throw new Error("No WebSocket");
	expect((await ask(socket, "Build the login page")).text).toBe("Looks good.");
	socket.close();

	const root = await settled(registry);
	const [child] = await registry.listNestedRuns(root.id);
	expect(root).toMatchObject({ agentName: "Planner", status: "succeeded", steps: 2 });
	expect(root.total.runs).toBe(2);
	expect(child).toMatchObject({ agentName: "Coder", status: "succeeded", parentRunId: root.id });

	// The list has the person's message once, with the run it led to in its total.
	const list = await page("/team-forge/runs", cookie);
	expect(list).toContain(`href="/team-forge/runs/${root.id}"`);
	expect(list).not.toContain(`href="/team-forge/runs/${child?.id}"`);
	expect(list).toContain(
		'Planner<span class="font-normal text-muted-foreground"> and 1 more</span>',
	);

	// The caller's trace shows the run its edge started, which opens to its own.
	const caller = await page(`/team-forge/runs/${root.id}`, cookie);
	expect(caller).toContain("Delegate to <span");
	expect(caller).toContain(`href="/team-forge/runs/${child?.id}"`);
	expect(caller).toContain("Open its run");
	expect(caller).toContain("Open the conversation");
	// React escapes the apostrophe.
	expect(caller).toContain("With the run it led to over its team&#x27;s edges");

	const nested = await page(`/team-forge/runs/${child?.id}`, cookie);
	expect(nested).toContain("Delegated to by");
	expect(nested).toContain(`href="/team-forge/runs/${root.id}"`);
	expect(nested).toContain("Model request 1");
	expect(nested).not.toContain("Open the conversation");

	// The conversation shows the team beside it, and is listed as the team's.
	const chat = await page(`/team-forge/chat/${conversation.id}`, cookie);
	expect(chat).toContain('aria-label="The team"');
	expect(chat).toContain("led by");
	expect(chat).toContain(`href="/team-forge/teams/${team.id}"`);
	expect(chat).toContain("Builders (team)");

	// The conversation Coder's turn ran in is reached only by Planner's, never through the gateway.
	const direct = await agents.fetch(
		`${origin}/api/chat/team-forge/${child?.conversationId}/get-messages`,
		{ headers: { cookie } },
	);
	expect(direct.status).toBe(404);
});
