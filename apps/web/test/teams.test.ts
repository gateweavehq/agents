import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments, and escapes apostrophes.
	return (await response.text()).replaceAll("<!-- -->", "").replaceAll("&#x27;", "'");
}

const define = (name: string) => ({
	name,
	description: null,
	provider: "anthropic" as const,
	model: "claude-sonnet-5-5",
	instructions: null,
});

it("shows teams, their graph, members and edges, and lets only admins change them", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-teams");
	const workspaceId = await createWorkspace(agents, origin, ada, "forge");
	const registry = await agents.registry(workspaceId);

	const empty = await page("/forge/teams", ada.cookie);
	expect(empty).toContain("No teams yet");
	expect(empty).toContain('href="/forge/teams"');

	const planner = await registry.createAgent(define("Planner"));
	const coder = await registry.createAgent(define("Coder"));
	const qaLead = await registry.createAgent(define("Tester"));
	const qa = await registry.createTeam({ name: "QA", description: null, lead: qaLead.id });
	const builders = await registry.createTeam({
		name: "Builders",
		description: "Plans and ships features",
		lead: planner.id,
	});
	await registry.setTeamGraph(builders.id, {
		lead: planner.id,
		members: [
			{ kind: "agent", id: planner.id },
			{ kind: "agent", id: coder.id },
			{ kind: "team", id: qa.id },
		],
		edges: [
			{ from: planner.id, to: coder.id, kind: "delegate" },
			{ from: planner.id, to: qa.id, kind: "ask" },
			{ from: coder.id, to: planner.id, kind: "report" },
		],
	});

	const list = await page("/forge/teams", ada.cookie);
	for (const text of [
		"Builders",
		"Plans and ships features",
		"3 members",
		"Led by Planner",
		"QA",
	]) {
		expect(list).toContain(text);
	}
	expect(list).toContain("New team");

	const team = await page(`/forge/teams/${builders.id}`, ada.cookie);
	for (const text of [
		"Members · 3",
		"Edges · 3",
		"Planner delegates to Coder",
		"Planner asks QA",
		"Coder reports to Planner",
		"Team led by Tester",
		"Add member",
		"Add edge",
	]) {
		expect(team.replace(/<[^>]+>/g, "")).toContain(text);
	}
	// The drawing links each member to its page.
	expect(team).toContain(`href="/forge/agents/${coder.id}"`);
	expect(team).toContain(`href="/forge/teams/${qa.id}"`);
	expect(await page(`/forge/teams/${qa.id}`, ada.cookie)).toContain(
		`href="/forge/teams/${builders.id}"`,
	);

	// A member sees the same team, without the means to change it.
	const { userId: grace, headers: graceHeaders } = await signUp(agents, origin, "grace-teams");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace, Date.now())
		.run();
	const seen = await page(`/forge/teams/${builders.id}`, graceHeaders.cookie);
	expect(seen.replace(/<[^>]+>/g, "")).toContain("Planner delegates to Coder");
	expect(seen).not.toContain("Add member");
	expect(seen).not.toContain("Make lead");
	expect(await page("/forge/teams", graceHeaders.cookie)).not.toContain("New team");

	// Anyone else gets the same answer as for a workspace that does not exist.
	const { headers: eve } = await signUp(agents, origin, "eve-teams");
	const outsider = await agents.fetch(`${origin}/forge/teams/${builders.id}`, {
		headers: { cookie: eve.cookie },
	});
	expect(outsider.status).toBe(404);
	expect(await outsider.text()).not.toContain("Planner");
});
