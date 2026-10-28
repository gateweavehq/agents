import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TeamGraphInput } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

/** Calls the object directly, for calls expected to throw (see registry.test.ts). */
const inside = <T>(stub: ReturnType<typeof registry>, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

async function agent(stub: ReturnType<typeof registry>, name: string) {
	const created = await stub.createAgent({
		name,
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	return created.id;
}

async function team(stub: ReturnType<typeof registry>, name: string, lead: string) {
	return (await stub.createTeam({ name, description: null, lead })).id;
}

const agents = (...ids: string[]) => ids.map((id) => ({ kind: "agent" as const, id }));
const teams = (...ids: string[]) => ids.map((id) => ({ kind: "team" as const, id }));

describe("teams", () => {
	it("start with their lead, and keep members and edges", async () => {
		const stub = registry();
		const planner = await agent(stub, "Planner");
		const coder = await agent(stub, "Coder");
		const created = await stub.createTeam({
			name: "Builders",
			description: "  ",
			lead: planner,
		});
		expect(created).toMatchObject({ name: "Builders", description: null, leadAgentId: planner });
		expect(await stub.getTeam(created.id)).toMatchObject({
			members: [{ kind: "agent", id: planner, name: "Planner", removed: false }],
			edges: [],
			partOf: [],
		});

		const graph: TeamGraphInput = {
			lead: planner,
			members: agents(coder, planner),
			edges: [
				{ from: planner, to: coder, kind: "delegate" },
				{ from: coder, to: planner, kind: "report" },
			],
		};
		await stub.setTeamGraph(created.id, graph);
		const detail = await stub.getTeam(created.id);
		// The lead comes first.
		expect(detail?.members.map((member) => member.name)).toEqual(["Planner", "Coder"]);
		expect(detail?.members[1]).toEqual({
			kind: "agent",
			id: coder,
			name: "Coder",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			removed: false,
		});
		expect(detail?.edges).toHaveLength(2);
		expect(detail?.edges).toEqual(expect.arrayContaining(graph.edges));
		expect(await stub.listTeams()).toEqual([
			{
				team: expect.objectContaining({ id: created.id, name: "Builders" }),
				lead: { id: planner, name: "Planner", removed: false },
				members: 2,
			},
		]);

		// The lead can change to another of its agents.
		await stub.setTeamGraph(created.id, { ...graph, lead: coder });
		expect((await stub.getTeam(created.id))?.team.leadAgentId).toBe(coder);

		expect(
			await stub.updateTeam(created.id, { name: "Makers", description: "Ship it" }),
		).toMatchObject({ name: "Makers", description: "Ship it" });
		expect(await stub.deleteTeam(created.id)).toBe(true);
		expect(await stub.getTeam(created.id)).toBeNull();
		expect(await stub.listTeams()).toEqual([]);
		expect(await stub.deleteTeam(created.id)).toBe(false);
		expect(await stub.setTeamGraph(created.id, graph)).toBeNull();
	});

	it("refuse members and edges that do not fit", async () => {
		const stub = registry();
		const planner = await agent(stub, "Planner");
		const coder = await agent(stub, "Coder");
		const builders = await team(stub, "Builders", planner);
		const base = { lead: planner, members: agents(planner, coder) };

		await inside(stub, (instance) => {
			expect(() =>
				instance.setTeamGraph(builders, {
					...base,
					edges: [{ from: planner, to: planner, kind: "ask" }],
				}),
			).toThrow("An edge goes from one member to another");
			expect(() =>
				instance.setTeamGraph(builders, {
					...base,
					edges: [{ from: planner, to: "someone-else", kind: "ask" }],
				}),
			).toThrow("An edge goes between members of the team");
			expect(() =>
				instance.setTeamGraph(builders, {
					lead: coder,
					members: agents(planner),
					edges: [],
				}),
			).toThrow("The lead is one of the team's agents");
			expect(() =>
				instance.setTeamGraph(builders, {
					lead: planner,
					members: agents(planner, planner),
					edges: [],
				}),
			).toThrow("A member is listed twice");
			expect(() =>
				instance.setTeamGraph(builders, { ...base, members: agents(planner, "nobody"), edges: [] }),
			).toThrow("Only agents run by Gateweave can be in a team");
			expect(() =>
				instance.setTeamGraph(builders, {
					...base,
					members: [...agents(planner), ...teams("nothing")],
					edges: [],
				}),
			).toThrow("That team does not exist");
			expect(() => instance.createTeam({ name: "Nobody's", description: null, lead: "x" })).toThrow(
				"A team is led by an agent run by Gateweave",
			);
		});
	});

	it("never contain themselves, however deep", async () => {
		const stub = registry();
		const lead = await agent(stub, "Lead");
		const outer = await team(stub, "Outer", lead);
		const middle = await team(stub, "Middle", lead);
		const inner = await team(stub, "Inner", lead);
		await stub.setTeamGraph(outer, {
			lead,
			members: [...agents(lead), ...teams(middle)],
			edges: [],
		});
		await stub.setTeamGraph(middle, {
			lead,
			members: [...agents(lead), ...teams(inner)],
			edges: [],
		});
		expect((await stub.getTeam(middle))?.partOf).toEqual([{ id: outer, name: "Outer" }]);
		expect((await stub.getTeam(outer))?.members[1]).toEqual({
			kind: "team",
			id: middle,
			name: "Middle",
			lead: { id: lead, name: "Lead" },
			members: 2,
		});

		await inside(stub, (instance) => {
			expect(() =>
				instance.setTeamGraph(outer, {
					lead,
					members: [...agents(lead), ...teams(outer)],
					edges: [],
				}),
			).toThrow("A team cannot be a member of itself");
			expect(() =>
				instance.setTeamGraph(inner, {
					lead,
					members: [...agents(lead), ...teams(outer)],
					edges: [],
				}),
			).toThrow("Outer contains Inner, so Inner cannot contain Outer");
			// A team in another one stays until it is taken out.
			expect(() => instance.deleteTeam(middle)).toThrow(
				"Middle is a member of Outer. Take it out of there first",
			);
		});
		await stub.setTeamGraph(outer, { lead, members: agents(lead), edges: [] });
		expect(await stub.deleteTeam(middle)).toBe(true);
	});

	it("never let delegate and ask edges go in a circle, with teams standing for their leads", async () => {
		const stub = registry();
		const planner = await agent(stub, "Planner");
		const coder = await agent(stub, "Coder");
		const tester = await agent(stub, "Tester");
		const builders = await team(stub, "Builders", planner);

		await inside(stub, (instance) => {
			expect(() =>
				instance.setTeamGraph(builders, {
					lead: planner,
					members: agents(planner, coder, tester),
					edges: [
						{ from: planner, to: coder, kind: "delegate" },
						{ from: coder, to: tester, kind: "delegate" },
						{ from: tester, to: planner, kind: "ask" },
					],
				}),
			).toThrow("Delegate and ask edges would go in a circle: Planner → Coder → Tester → Planner");
		});
		// Reports do not wait, so they may go back up.
		await stub.setTeamGraph(builders, {
			lead: planner,
			members: agents(planner, coder, tester),
			edges: [
				{ from: planner, to: coder, kind: "delegate" },
				{ from: coder, to: tester, kind: "delegate" },
				{ from: tester, to: planner, kind: "report" },
			],
		});

		// A team in another stands for its lead: Planner delegates to QA, which Tester leads.
		const qa = await team(stub, "QA", tester);
		await stub.setTeamGraph(builders, {
			lead: planner,
			members: [...agents(planner), ...teams(qa)],
			edges: [{ from: planner, to: qa, kind: "delegate" }],
		});
		await inside(stub, (instance) => {
			// Inside QA, Tester asking Planner closes a circle in Builders, which contains QA.
			expect(() =>
				instance.setTeamGraph(qa, {
					lead: tester,
					members: agents(tester, planner),
					edges: [{ from: tester, to: planner, kind: "ask" }],
				}),
			).toThrow(
				"Delegate and ask edges would go in a circle in Builders: Planner → Tester → Planner",
			);
			// So does making Planner QA's lead: Planner would delegate to itself.
			expect(() =>
				instance.setTeamGraph(qa, { lead: planner, members: agents(tester, planner), edges: [] }),
			).toThrow("Delegate and ask edges would go in a circle in Builders: Planner → Planner");
		});
		// On its own, QA may have Tester ask Planner.
		await stub.setTeamGraph(builders, { lead: planner, members: agents(planner), edges: [] });
		await stub.setTeamGraph(qa, {
			lead: tester,
			members: agents(tester, planner),
			edges: [{ from: tester, to: planner, kind: "ask" }],
		});
	});

	it("keep a removed agent, marked, until someone takes it out", async () => {
		const stub = registry();
		const planner = await agent(stub, "Planner");
		const coder = await agent(stub, "Coder");
		const builders = await team(stub, "Builders", planner);
		const graph: TeamGraphInput = {
			lead: planner,
			members: agents(planner, coder),
			edges: [{ from: planner, to: coder, kind: "delegate" }],
		};
		await stub.setTeamGraph(builders, graph);
		await stub.removeAgent(coder);
		await stub.removeAgent(planner);

		const detail = await stub.getTeam(builders);
		expect(detail?.members.map((member) => member.kind === "agent" && member.removed)).toEqual([
			true,
			true,
		]);
		expect(detail?.edges).toEqual(graph.edges);
		expect((await stub.listTeams())[0]?.lead).toEqual({
			id: planner,
			name: "Planner",
			removed: true,
		});
		// Saving the graph keeps them where they were.
		await stub.setTeamGraph(builders, { ...graph, edges: [] });

		const tester = await agent(stub, "Tester");
		const qa = await team(stub, "QA", tester);
		await inside(stub, (instance) => {
			expect(() =>
				instance.setTeamGraph(qa, { lead: tester, members: agents(tester, coder), edges: [] }),
			).toThrow("Coder was removed, so it cannot join a team");
			expect(() =>
				instance.setTeamGraph(builders, {
					lead: coder,
					members: agents(planner, coder),
					edges: [],
				}),
			).toThrow("Coder was removed, so it cannot lead a team");
			expect(() => instance.createTeam({ name: "Old", description: null, lead: coder })).toThrow(
				"Coder was removed, so it cannot lead a team",
			);
		});
	});
});
