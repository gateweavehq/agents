import type { TeamDetail } from "@gateweave/agents-model";
import { expect, it } from "vitest";
import type { ChatActivity } from "./chat";
import { teamAtWork } from "./team-activity";

const detail = {
	team: { id: "builders", leadAgentId: "planner" },
	members: [
		{ kind: "agent", id: "planner", name: "Planner" },
		{ kind: "agent", id: "coder", name: "Coder" },
		{ kind: "team", id: "qa", name: "QA" },
	],
	edges: [],
	partOf: [],
} as unknown as TeamDetail;

const run = (id: string, agentId: string, agentName: string, teamPath: string[] | null) =>
	({ id, agentId, agentName, edge: null, teamPath }) satisfies ChatActivity;

it("lights the agents at work in the team, and a member team for those inside it", () => {
	const { members, agents } = teamAtWork(detail, [
		run("1", "planner", "Planner", ["builders"]),
		run("2", "coder", "Coder", ["builders"]),
		run("3", "tester", "Tester", ["builders", "qa"]),
		run("4", "fuzzer", "Fuzzer", ["builders", "qa", "fuzzing"]),
	]);
	expect([...members]).toEqual(["planner", "coder", "qa"]);
	expect(agents).toEqual([
		{ runId: "1", name: "Planner", within: null },
		{ runId: "2", name: "Coder", within: null },
		{ runId: "3", name: "Tester", within: "QA" },
		{ runId: "4", name: "Fuzzer", within: "QA" },
	]);
});

it("leaves out runs that are not the team's, or of members it no longer has", () => {
	expect(
		teamAtWork(detail, [
			run("1", "planner", "Planner", null),
			run("2", "coder", "Coder", ["elsewhere"]),
			run("3", "designer", "Designer", ["builders"]),
		]),
	).toEqual({ members: new Set(), agents: [] });
});
