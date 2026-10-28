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

/** Every run, once the runtime has reported how each ended. */
async function settled(registry: RegistryStub, count: number) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const runs = await registry.listRuns();
		if (runs.length === count && runs.every((run) => run.status !== "running")) return runs;
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
	const conversation = await registry.startTeamConversation(team.id, owner.userId);
	if (!conversation) throw new Error("The conversation did not start");

	const cookie = owner.headers.cookie;
	const { socket } = await agents.connect(`${origin}/api/chat/team-forge/${conversation.id}`, {
		cookie,
		origin,
	});
	if (!socket) throw new Error("No WebSocket");
	expect((await ask(socket, "Build the login page")).text).toBe("Looks good.");
	socket.close();

	const runs = await settled(registry, 2);
	const root = runs.find((run) => run.parentRunId === null);
	const child = runs.find((run) => run.parentRunId !== null);
	expect(root).toMatchObject({ agentName: "Planner", status: "succeeded", steps: 2 });
	expect(child).toMatchObject({ agentName: "Coder", status: "succeeded", parentRunId: root?.id });

	const caller = await page(`/team-forge/runs/${root?.id}`, cookie);
	expect(caller).toContain("Delegate to <span");
	expect(caller).toContain(`href="/team-forge/runs/${child?.id}"`);
	expect(caller).toContain("Open its run");
	expect(caller).toContain("Open the conversation");

	const nested = await page(`/team-forge/runs/${child?.id}`, cookie);
	expect(nested).toContain("Delegated to by");
	expect(nested).toContain(`href="/team-forge/runs/${root?.id}"`);
	expect(nested).toContain("Model request 1");
	expect(nested).not.toContain("Open the conversation");

	// The conversation Coder's turn ran in is reached only by Planner's, never through the gateway.
	const direct = await agents.fetch(
		`${origin}/api/chat/team-forge/${child?.conversationId}/get-messages`,
		{ headers: { cookie } },
	);
	expect(direct.status).toBe(404);
});
