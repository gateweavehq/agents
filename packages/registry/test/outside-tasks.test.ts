import { env } from "cloudflare:workers";
import type { AgentDefinitionInput } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

function reviewer(fields: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
	return {
		name: "Reviewer",
		description: "  ",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		...fields,
	};
}

const task = (agent: string, requestId: string, text = "Review the change.") => ({
	agent,
	requestId,
	askedBy: "user-1",
	askedVia: "client-1",
	task: text,
});

describe("outside tasks (AGT-155)", () => {
	it("refuses an agent without outside tasks allowed, and admits one that has them", async () => {
		const stub = registry();
		const closed = await stub.createAgent(reviewer());
		const open = await stub.createAgent(reviewer({ name: "Builder", outsideTasks: true }));

		expect(await stub.admitOutsideTask(task(closed.id, "r1"))).toEqual({
			status: "refused",
			message:
				'That agent does not allow tasks from outside. A workspace owner or admin can turn on "Tasks from MCP clients" in the agent\'s settings.',
		});

		const admitted = await stub.admitOutsideTask(task("Builder", "r1"));
		expect(admitted.status).toBe("start");
		if (admitted.status !== "start") return;
		// The same requestId finds the task it opened, and starts nothing twice.
		expect(await stub.admitOutsideTask(task("Builder", "r1"))).toEqual({
			status: "starting",
			retryAfter: 60,
		});
		const conversation = await stub.getConversation(admitted.conversationId, "user-1");
		expect(conversation).toMatchObject({ agentId: open.id, triggerId: null });
	});

	it("name a task by who asked as well, so two clients' requestIds never meet", async () => {
		const stub = registry();
		await stub.createAgent(reviewer({ name: "Builder", outsideTasks: true }));
		const first = await stub.admitOutsideTask(task("Builder", "r1"));
		// Another OAuth client reusing "r1" is another task, not the first one's retry.
		const second = await stub.admitOutsideTask({ ...task("Builder", "r1"), askedVia: "client-2" });
		expect(first.status).toBe("start");
		expect(second.status).toBe("start");
		if (first.status !== "start" || second.status !== "start") return;
		expect(second.conversationId).not.toBe(first.conversationId);
	});

	it("hold an agent to its tasks per minute", async () => {
		const stub = registry();
		await stub.createAgent(reviewer({ outsideTasks: true }));
		for (let i = 0; i < 10; i++) {
			expect(await stub.admitOutsideTask(task("Reviewer", `r${i}`)).status).toBe("start");
		}
		const eleventh = await stub.admitOutsideTask(task("Reviewer", "r10"));
		expect(eleventh).toMatchObject({ status: "limited" });
	});

	it("refuse a name two agents share, and take an id instead", async () => {
		const stub = registry();
		await stub.createAgent(reviewer({ outsideTasks: true }));
		await stub.createAgent(reviewer({ name: "Reviewer", outsideTasks: true }));
		expect(await stub.admitOutsideTask(task("Reviewer", "r1"))).toMatchObject({
			status: "refused",
			message: expect.stringContaining("More than one agent"),
		});
		const first = (await stub.listAgents())[0];
		expect(await stub.admitOutsideTask(task(first?.id ?? "", "r2")).status).toBe("start");
	});
});

it("settles an outside task with its agent's pause reason", async () => {
	const stub = registry();
	const agent = await stub.createAgent(reviewer({ outsideTasks: true }));
	const admitted = await stub.admitOutsideTask(task(agent.id, "r1"));
	if (admitted.status !== "start") throw new Error(admitted.status);
	await stub.pauseAgent(agent.id, "admin");
	const refusal = {
		status: "refused",
		message: "This agent is paused, so it takes no new turns. An owner or admin can resume it.",
	};
	expect(await stub.beginOutsideTurn(admitted.conversationId, "Review")).toEqual(refusal);
	expect(await stub.admitOutsideTask(task(agent.id, "r1"))).toEqual(refusal);
	expect(await stub.listRuns()).toEqual([]);
});
