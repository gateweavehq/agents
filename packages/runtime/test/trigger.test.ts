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
