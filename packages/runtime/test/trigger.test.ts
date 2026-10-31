import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { anthropicStream, fakeModel, KEY } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

const EVENT = JSON.stringify({ type: "issue.created", data: { title: "Login fails" } });

/** Signs as a Standard Webhooks sender does. */
async function sign(secret: string, id: string, timestamp: string, body: string) {
	const raw = Uint8Array.from(atob(secret.slice("whsec_".length)), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${id}.${timestamp}.${body}`),
	);
	return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

/** A delivery the registry took, and the conversation it opened for its run. */
async function delivered({ key = true } = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	if (key) await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const agent = await registry.createAgent({
		name: "Triager",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	const made = await registry.createTrigger(
		{
			name: "New issues",
			prompt: "Triage this issue: {{data.title}}",
			target: { kind: "agent", agentId: agent.id },
		},
		"user-ada",
	);
	if ("status" in made) throw new Error(made.message);
	const id = crypto.randomUUID();
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await sign(made.secret, id, timestamp, EVENT);
	const receipt = await registry.receiveTrigger(
		made.trigger.id,
		{ id, timestamp, signature },
		EVENT,
	);
	if (receipt.status !== "start") throw new Error(`The delivery was ${receipt.status}`);
	const stub = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, receipt.conversationId),
	);
	return { registry, stub, receipt, trigger: made.trigger };
}

describe("a trigger's turn", () => {
	it("answers the trigger's message with nobody waiting, and keeps the conversation", async () => {
		const { registry, stub, receipt } = await delivered();
		const requests = fakeModel(() => anthropicStream("Triaged: a login bug."));

		const outcome = await stub.triggerTurn(receipt.text);
		if (outcome.runId === null) throw new Error(outcome.error);
		await vi.waitFor(async () =>
			expect(await registry.getRun(outcome.runId)).toMatchObject({ status: "succeeded" }),
		);
		expect(requests).toHaveLength(1);
		const sent = JSON.stringify(requests[0]?.body.messages);
		expect(sent).toContain("Triage this issue: Login fails");
		expect(sent).toContain("issue.created");

		const transcript = JSON.parse(await stub.transcript()) as {
			role: string;
			parts: unknown[];
		}[];
		expect(transcript.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(JSON.stringify(transcript[1]?.parts)).toContain("Triaged: a login bug.");

		// The delivery had its run; the conversation takes no other.
		expect(await stub.triggerTurn(receipt.text)).toEqual({
			runId: null,
			error: "This delivery has had its run already",
		});
	});

	it("tells the agent its run's page after the trigger's message", async () => {
		const { registry, stub, receipt } = await delivered();
		const requests = fakeModel(() => anthropicStream("On it."));

		const outcome = await stub.triggerTurn(receipt.text, "https://agents.example.com/acme/runs/");
		if (outcome.runId === null) throw new Error(outcome.error);
		await vi.waitFor(async () =>
			expect(await registry.getRun(outcome.runId)).toMatchObject({ status: "succeeded" }),
		);
		const sent = JSON.stringify(requests[0]?.body.messages);
		expect(sent).toContain(
			`This run's page, where people can follow your work in Gateweave Agents: https://agents.example.com/acme/runs/${outcome.runId}`,
		);
	});

	it("leaves out a runs page that is not a web address", async () => {
		const { registry, stub, receipt } = await delivered();
		const requests = fakeModel(() => anthropicStream("On it."));

		const outcome = await stub.triggerTurn(receipt.text, "javascript:alert(1)//");
		if (outcome.runId === null) throw new Error(outcome.error);
		await vi.waitFor(async () =>
			expect(await registry.getRun(outcome.runId)).toMatchObject({ status: "succeeded" }),
		);
		const sent = JSON.stringify(requests[0]?.body.messages);
		expect(sent).toContain(`This run is ${outcome.runId} in Gateweave Agents.`);
		expect(sent).not.toContain("javascript:");
	});

	it("continues an issue's conversation with what was said before, for a per-issue trigger", async () => {
		const workspaceId = crypto.randomUUID();
		const registry = env.REGISTRY.getByName(workspaceId);
		await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const agent = await registry.createAgent({
			name: "Coder",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
		});
		const made = await registry.createTrigger(
			{
				name: "Assigned issues",
				prompt: "{{type}} on {{data.issue.key}}",
				target: { kind: "agent", agentId: agent.id },
				assignee: "member-coder",
				perIssue: true,
			},
			"user-ada",
		);
		if ("status" in made) throw new Error(made.message);
		const deliver = async (type: string, extra: Record<string, unknown> = {}) => {
			const body = JSON.stringify({
				type,
				data: {
					workspace: { id: "w-1", slug: "acme" },
					actor: { id: "member-maya", name: "Maya", type: "person" },
					issue: { id: "issue-7", key: "ENG-7", assigneeId: "member-coder" },
					...extra,
				},
			});
			const id = crypto.randomUUID();
			const timestamp = String(Math.floor(Date.now() / 1000));
			const signature = await sign(made.secret, id, timestamp, body);
			const receipt = await registry.receiveTrigger(
				made.trigger.id,
				{ id, timestamp, signature },
				body,
			);
			if (receipt.status !== "start") throw new Error(`The delivery was ${receipt.status}`);
			return receipt;
		};
		const answers = ["Which button do you mean?", "Done: the blue one."];
		const requests = fakeModel(() => anthropicStream(answers.shift() ?? "Nothing more."));
		const turn = async (receipt: { conversationId: string; text: string }) => {
			const stub = await getAgentByName(
				env.CONVERSATIONS,
				conversationName(workspaceId, receipt.conversationId),
			);
			const outcome = await stub.triggerTurn(receipt.text);
			if (outcome.runId === null) throw new Error(outcome.error);
			await vi.waitFor(async () =>
				expect(await registry.getRun(outcome.runId)).toMatchObject({ status: "succeeded" }),
			);
			return stub;
		};

		const assigned = await deliver("issue.created");
		await turn(assigned);
		const commented = await deliver("comment.created", { comment: { body: "The blue one" } });
		expect(commented.conversationId).toBe(assigned.conversationId);
		const stub = await turn(commented);

		// The second turn's request carries the first exchange before the comment.
		expect(requests).toHaveLength(2);
		const sent = JSON.stringify(requests[1]?.body.messages);
		for (const said of ["issue.created on ENG-7", "Which button do you mean?", "The blue one"]) {
			expect(sent).toContain(said);
		}
		const transcript = JSON.parse(await stub.transcript()) as { role: string }[];
		expect(transcript.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("says why its run could not begin, and the delivery shows it", async () => {
		const { registry, stub, receipt, trigger } = await delivered({ key: false });
		const requests = fakeModel(() => anthropicStream("Never sent"));

		const outcome = await stub.triggerTurn(receipt.text);
		expect(outcome).toEqual({
			runId: null,
			error: expect.stringContaining("has no Anthropic key"),
		});
		expect(requests).toHaveLength(0);
		expect(await stub.transcript()).toBe("[]");
		const [listed] = await registry.listTriggers({
			kind: "agent",
			agentId: trigger.target.kind === "agent" ? trigger.target.agentId : "",
		});
		expect(listed?.deliveries[0]).toMatchObject({
			status: "failed",
			error: expect.stringContaining("has no Anthropic key"),
		});
	});
});
