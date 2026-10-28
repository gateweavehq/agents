import { env } from "cloudflare:workers";
import { TEAM_TURN_LIMITS, type TurnVia } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;

const ADA = "user-ada";
const KEY = "sk-ant-api03-abcdefgh";

const agents = (...ids: string[]) => ids.map((id) => ({ kind: "agent" as const, id }));
const teams = (...ids: string[]) => ids.map((id) => ({ kind: "team" as const, id }));

/**
 * Builders: Planner leads, delegates to Coder and asks QA; Coder delegates to QA, and QA reports
 * to Planner. QA, a team in Builders: Tester leads and delegates to Fuzzer.
 */
async function workspace() {
	const stub = registry();
	await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const agent = async (name: string) =>
		(
			await stub.createAgent({
				name,
				description: `${name} at work`,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: null,
			})
		).id;
	const planner = await agent("Planner");
	const coder = await agent("Coder");
	const tester = await agent("Tester");
	const fuzzer = await agent("Fuzzer");
	const qa = (await stub.createTeam({ name: "QA", description: "Tests things", lead: tester })).id;
	await stub.setTeamGraph(qa, {
		lead: tester,
		members: agents(tester, fuzzer),
		edges: [{ from: tester, to: fuzzer, kind: "delegate" }],
	});
	const builders = (await stub.createTeam({ name: "Builders", description: null, lead: planner }))
		.id;
	const graph = {
		lead: planner,
		members: [...agents(planner, coder), ...teams(qa)],
		edges: [
			{ from: planner, to: coder, kind: "delegate" as const },
			{ from: planner, to: qa, kind: "ask" as const },
			{ from: coder, to: qa, kind: "delegate" as const },
			{ from: qa, to: planner, kind: "report" as const },
		],
	};
	await stub.setTeamGraph(builders, graph);
	return { stub, planner, coder, tester, fuzzer, qa, builders, graph };
}

/** Begins a turn, failing the test when it is refused. */
async function begin(stub: Stub, conversation: string, text: string, via?: TurnVia) {
	const turn = await stub.beginTurn(conversation, text, via);
	if ("status" in turn) throw new Error(turn.message);
	return turn;
}

/** A turn of the person's conversation with Builders. */
async function message(stub: Stub, builders: string) {
	const conversation = (await stub.startTeamConversation(builders, ADA))?.id ?? "";
	return { conversation, turn: await begin(stub, conversation, "Build the login page") };
}

const via = (parentRunId: string, kind: TurnVia["kind"], team: string, to: string): TurnVia => ({
	parentRunId,
	parentSpanId: crypto.randomUUID(),
	kind,
	team,
	to,
});

describe("a conversation with a team", () => {
	it("is answered by the lead, with the lead's edges as tools", async () => {
		const { stub, planner, coder, qa, builders } = await workspace();
		const started = await stub.startTeamConversation(builders, ADA);
		expect(started).toMatchObject({
			agentId: planner,
			agentName: "Planner",
			teamId: builders,
			teamName: "Builders",
		});
		expect(await stub.startTeamConversation(crypto.randomUUID(), ADA)).toBeNull();

		const turn = await begin(stub, started?.id ?? "", "Build the login page");
		expect(turn.agent.name).toBe("Planner");
		expect(turn.edges).toEqual([
			{
				kind: "delegate",
				team: builders,
				to: coder,
				name: "Coder",
				description: "Coder at work",
				lead: null,
			},
			{
				kind: "ask",
				team: builders,
				to: qa,
				name: "QA",
				description: "Tests things",
				lead: "Tester",
			},
		]);
		expect(await stub.getRun(turn.runId)).toMatchObject({
			agentId: planner,
			teamPath: [builders],
			depth: 0,
			parentRunId: null,
			rootRunId: null,
			edge: null,
		});
	});

	it("goes on with the team's lead as it is now, and stops once nobody leads it", async () => {
		const { stub, coder, builders, graph } = await workspace();
		const conversation = (await stub.startTeamConversation(builders, ADA))?.id ?? "";
		await stub.setTeamGraph(builders, { ...graph, lead: coder });
		expect((await begin(stub, conversation, "Hello")).agent.name).toBe("Coder");

		await stub.removeAgent(coder);
		expect(await stub.beginTurn(conversation, "Hello")).toEqual({
			status: "refused",
			message:
				"The lead of Builders was removed, so the team cannot answer. An owner or admin can choose another lead on the team's page.",
		});
	});
});

describe("nested turns", () => {
	it("follow the team's edges, each with a run under the caller's", async () => {
		const { stub, planner, coder, tester, fuzzer, qa, builders } = await workspace();
		const { conversation, turn: root } = await message(stub, builders);

		const toCoder = via(root.runId, "delegate", builders, coder);
		const coderTurn = await begin(stub, "nested-coder", "Write the form", toCoder);
		expect(coderTurn.agent.name).toBe("Coder");
		expect(coderTurn.edges.map((edge) => [edge.kind, edge.name])).toEqual([["delegate", "QA"]]);
		expect(await stub.getRun(coderTurn.runId)).toMatchObject({
			agentId: coder,
			conversationId: "nested-coder",
			startedBy: ADA,
			parentRunId: root.runId,
			parentSpanId: toCoder.parentSpanId,
			rootRunId: root.runId,
			edge: "delegate",
			depth: 1,
			teamPath: [builders],
		});

		// A team is reached through its lead, who also takes the team's own edges in Builders.
		const testerTurn = await begin(
			stub,
			"nested-tester",
			"Test the form",
			via(coderTurn.runId, "delegate", builders, qa),
		);
		expect(testerTurn.agent.agentId).toBe(tester);
		expect(testerTurn.edges.map((edge) => [edge.kind, edge.team, edge.to])).toEqual([
			["delegate", qa, fuzzer],
			["report", builders, planner],
		]);
		expect(await stub.getRun(testerTurn.runId)).toMatchObject({
			rootRunId: root.runId,
			depth: 2,
			teamPath: [builders, qa],
		});

		// An ask is one request without tools, and takes no edges itself.
		const asked = await begin(
			stub,
			"nested-ask",
			"Is it tested?",
			via(root.runId, "ask", builders, qa),
		);
		expect(asked).toMatchObject({ mcpServers: [], edges: [] });
		expect(
			await stub.beginTurn("nested-x", "Hm", via(asked.runId, "delegate", qa, fuzzer)),
		).toEqual({ status: "refused", message: "An answer to a question takes no edges" });

		// The nested conversations are not the person's to list, open or go on with.
		expect((await stub.listConversations(ADA)).map((listed) => listed.id)).toEqual([conversation]);
		expect(await stub.getConversation("nested-coder", ADA)).toBeNull();
		expect(await stub.beginTurn("nested-coder", "Go on")).toEqual({
			status: "refused",
			message: "This conversation was a turn of a team's agent, so it cannot go on",
		});
		// They go with the conversation they belong to.
		expect((await stub.removeConversation(conversation, ADA)).sort()).toEqual(
			[conversation, "nested-ask", "nested-coder", "nested-tester"].sort(),
		);
		expect((await stub.getRun(coderTurn.runId))?.conversationId).toBeNull();
	});

	it("are refused unless the graph has the edge as the turn begins", async () => {
		const { stub, planner, coder, tester, qa, builders, graph } = await workspace();
		const { turn: root } = await message(stub, builders);
		const refusal = (message: string) => ({ status: "refused", message });

		// Not an edge of Planner's: Tester is in QA, and Planner only asks QA.
		expect(await stub.beginTurn("n1", "Hi", via(root.runId, "delegate", builders, qa))).toEqual(
			refusal("That edge is no longer in the team"),
		);
		expect(await stub.beginTurn("n2", "Hi", via(root.runId, "delegate", qa, tester))).toEqual(
			refusal("That edge is no longer in the team"),
		);

		await stub.setTeamGraph(builders, { ...graph, edges: graph.edges.slice(1) });
		expect(await stub.beginTurn("n3", "Hi", via(root.runId, "delegate", builders, coder))).toEqual(
			refusal("That edge is no longer in the team"),
		);

		// A conversation id is used once.
		await begin(stub, "n4", "Hi", via(root.runId, "ask", builders, qa));
		expect(await stub.beginTurn("n4", "Hi", via(root.runId, "ask", builders, qa))).toEqual(
			refusal("That conversation has had its turn already"),
		);

		// Only a running turn of a team takes edges.
		const plain = await stub.startConversation(planner, ADA);
		const alone = await begin(stub, plain?.id ?? "", "Hello");
		expect(await stub.beginTurn("n5", "Hi", via(alone.runId, "ask", builders, qa))).toEqual(
			refusal("Only a turn of a team can take its edges"),
		);
		await stub.finishRun(root.runId, {
			status: "succeeded",
			error: null,
			steps: 1,
			inputTokens: 1,
			outputTokens: 1,
			cachedInputTokens: 0,
			cost: 0,
			endedAt: Date.now(),
		});
		expect(await stub.beginTurn("n6", "Hi", via(root.runId, "ask", builders, qa))).toEqual(
			refusal("The turn that took this edge has ended"),
		);
	});

	it("stop where the limits are, so a team cannot run away", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const agent = async (name: string) =>
			(
				await stub.createAgent({
					name,
					description: null,
					provider: "anthropic",
					model: "claude-sonnet-5-5",
					instructions: null,
				})
			).id;
		const lead = await agent("Lead");
		const worker = await agent("Worker");
		// Reports may go back up, so turns could go back and forth forever but for the limits.
		const loop = (await stub.createTeam({ name: "Loop", description: null, lead })).id;
		await stub.setTeamGraph(loop, {
			lead,
			members: agents(lead, worker),
			edges: [
				{ from: lead, to: worker, kind: "delegate" },
				{ from: worker, to: lead, kind: "report" },
			],
		});
		const conversation = (await stub.startTeamConversation(loop, ADA))?.id ?? "";
		const root = await begin(stub, conversation, "Go");
		const toWorker = (parent: string) => via(parent, "delegate", loop, worker);
		const toLead = (parent: string) => via(parent, "report", loop, lead);
		const { depth, perTurn, perMessage } = TEAM_TURN_LIMITS;

		let parent = root.runId;
		for (let level = 1; level <= depth; level++) {
			const next = level % 2 === 1 ? toWorker(parent) : toLead(parent);
			parent = (await begin(stub, crypto.randomUUID(), "On", next)).runId;
		}
		const deeper = depth % 2 === 0 ? toWorker(parent) : toLead(parent);
		expect(await stub.beginTurn(crypto.randomUUID(), "On", deeper)).toEqual({
			status: "refused",
			message: `Turns go at most ${depth} edges deep from a message, so this one cannot go further`,
		});

		// The chain above used `depth` turns; the root's own count has one of them.
		const workers = [];
		for (let taken = 1; taken < perTurn; taken++) {
			workers.push((await begin(stub, crypto.randomUUID(), "Do", toWorker(root.runId))).runId);
		}
		expect(await stub.beginTurn(crypto.randomUUID(), "Do", toWorker(root.runId))).toEqual({
			status: "refused",
			message: `A turn can take at most ${perTurn} edges, and this one has`,
		});

		let total = depth + workers.length;
		for (const run of workers) {
			for (let taken = 0; taken < perTurn && total < perMessage; taken++, total++) {
				await begin(stub, crypto.randomUUID(), "Done", toLead(run));
			}
		}
		expect(total).toBe(perMessage);
		const last = workers.at(-1) ?? "";
		expect(await stub.beginTurn(crypto.randomUUID(), "Done", toLead(last))).toEqual({
			status: "refused",
			message: `One message can lead to at most ${perMessage} turns, and this one has`,
		});
	});
});

describe("a team's runs", () => {
	const finish = (stub: Stub, runId: string, cost: number | null) =>
		stub.finishRun(runId, {
			status: "succeeded",
			error: null,
			steps: 1,
			inputTokens: 1_000,
			outputTokens: 100,
			cachedInputTokens: 0,
			cost,
			endedAt: Date.now() + 1_000,
		});

	it("list each person's message once, with the total of the runs it led to", async () => {
		const { stub, coder, qa, builders } = await workspace();
		const { turn: root } = await message(stub, builders);
		const coderTurn = await begin(
			stub,
			"nested-coder",
			"Write the form",
			via(root.runId, "delegate", builders, coder),
		);
		const testerTurn = await begin(
			stub,
			"nested-tester",
			"Test the form",
			via(coderTurn.runId, "delegate", builders, qa),
		);
		const asked = await begin(stub, "nested-ask", "Tested?", via(root.runId, "ask", builders, qa));
		await finish(stub, root.runId, 2_000);
		await finish(stub, coderTurn.runId, null);
		await finish(stub, asked.runId, 500);

		const listed = await stub.listRuns();
		expect(listed.map((run) => run.id)).toEqual([root.runId]);
		expect(listed[0]?.total).toEqual({
			runs: 4,
			running: 1,
			inputTokens: 3_000,
			outputTokens: 300,
			cost: 2_500,
			unpriced: 1,
		});
		// A nested run's total is its own and those under it.
		expect((await stub.getRun(coderTurn.runId))?.total).toMatchObject({ runs: 2, running: 1 });
		expect((await stub.getRun(asked.runId))?.total).toMatchObject({ runs: 1, running: 0 });

		const called = await stub.listNestedRuns(root.runId);
		expect(called.map((run) => [run.agentName, run.edge, run.total.runs])).toEqual([
			["Coder", "delegate", 2],
			["Tester", "ask", 1],
		]);
		expect((await stub.listNestedRuns(coderTurn.runId)).map((run) => run.id)).toEqual([
			testerTurn.runId,
		]);
	});

	it("show who is at work in a conversation, to the member who had it", async () => {
		const { stub, coder, builders } = await workspace();
		const { conversation, turn: root } = await message(stub, builders);
		const coderTurn = await begin(
			stub,
			"nested-coder",
			"Write the form",
			via(root.runId, "delegate", builders, coder),
		);
		const working = async () =>
			(await stub.activeRuns(conversation, ADA))?.map((run) => [run.agentName, run.teamPath]);
		expect(await working()).toEqual([
			["Planner", [builders]],
			["Coder", [builders]],
		]);

		// A nested run is listed while it goes, even once the turn that called it ended, as a
		// report's does.
		await finish(stub, root.runId, 0);
		expect(await working()).toEqual([["Coder", [builders]]]);
		await finish(stub, coderTurn.runId, 0);
		expect(await working()).toEqual([]);

		expect(await stub.activeRuns(conversation, "user-grace")).toBeNull();
		expect(await stub.activeRuns("nested-coder", ADA)).toBeNull();
		expect(await stub.activeRuns("missing", ADA)).toBeNull();
	});
});
