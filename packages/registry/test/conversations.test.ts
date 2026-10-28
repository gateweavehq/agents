import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const ADA = "user-ada";
const GRACE = "user-grace";

async function withAgent(stub: ReturnType<typeof registry>) {
	return stub.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
}

describe("conversations", () => {
	it("belong to the member who started them", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const first = await stub.startConversation(agent.id, ADA);
		expect(first).toMatchObject({
			agentId: agent.id,
			agentName: "Reviewer",
			agentRemoved: false,
			title: null,
		});
		expect(first).not.toHaveProperty("startedBy");
		const id = first?.id ?? "";

		expect(await stub.getConversation(id, ADA)).toEqual(first);
		expect(await stub.getConversation(id, GRACE)).toBeNull();
		expect(await stub.listConversations(GRACE)).toEqual([]);
		expect(await stub.removeConversation(id, GRACE)).toBe(false);
		expect(await stub.listConversations(ADA)).toEqual([first]);

		expect(await stub.removeConversation(id, ADA)).toBe(true);
		expect(await stub.getConversation(id, ADA)).toBeNull();
	});

	it("are only had with live agents run by Gateweave", async () => {
		const stub = registry();
		expect(await stub.startConversation("no-such-agent", ADA)).toBeNull();
		const agent = await withAgent(stub);
		await stub.removeAgent(agent.id);
		expect(await stub.startConversation(agent.id, ADA)).toBeNull();
	});

	it("list the latest first, titled after their first message", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const older = await stub.startConversation(agent.id, ADA);
		const newer = await stub.startConversation(agent.id, ADA);
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");

		await stub.beginTurn(older?.id ?? "", `  Review   this\n${"x".repeat(200)}`);
		await stub.beginTurn(older?.id ?? "", "A later message");
		const listed = await stub.listConversations(ADA);
		expect(listed.map((conversation) => conversation.id)).toEqual([older?.id, newer?.id]);
		const title = listed[0]?.title ?? "";
		expect(title.startsWith("Review this xxx")).toBe(true);
		expect(title.endsWith("…")).toBe(true);
		expect(Array.from(title)).toHaveLength(80);
		expect(listed[1]?.title).toBeNull();

		expect(await stub.listConversations(ADA, "another-agent")).toEqual([]);
		expect(await stub.listConversations(ADA, agent.id)).toHaveLength(2);
	});

	it("hand the runtime the agent and its key for each turn, or say why not", async () => {
		const stub = registry();
		const rules = await stub.createLibraryAsset({
			kind: "instructions",
			name: "review rules",
			text: "Review the change.\n",
		});
		const agent = await stub.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: { assetId: rules, version: 1 },
		});
		const id = (await stub.startConversation(agent.id, ADA))?.id ?? "";

		expect(await stub.beginTurn(id, "Hello")).toEqual({
			status: "refused",
			message:
				"The workspace has no Anthropic key, so Reviewer cannot answer. An owner or admin can add one in Settings.",
		});
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		expect(await stub.beginTurn(id, "Hello")).toEqual({
			agent: {
				agentId: agent.id,
				name: "Reviewer",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: "Review the change.\n",
				updatedAt: agent.updatedAt,
			},
			key: "sk-ant-api03-abcdefgh",
			runId: expect.any(String),
		});

		// A removed agent's conversations stay readable, and cannot go on.
		await stub.removeAgent(agent.id);
		expect((await stub.getConversation(id, ADA))?.agentRemoved).toBe(true);
		expect(await stub.beginTurn(id, "Hello")).toEqual({
			status: "refused",
			message: "This agent was removed, so the conversation cannot go on",
		});

		await stub.removeConversation(id, ADA);
		expect(await stub.beginTurn(id, "Hello")).toEqual({
			status: "refused",
			message: "This conversation was deleted",
		});
	});
});
