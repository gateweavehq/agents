import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startAgents } from "./agents-worker";

// Local workerd has no jurisdictions. The objects we seal are in the default namespace, as
// they would be after a deployment moved into its first jurisdiction.
let agents: Awaited<ReturnType<typeof startAgents>>;
const day = 24 * 60 * 60 * 1000;
const key = "sk-proj-abcdefgh";

beforeAll(async () => {
	agents = await startAgents("https://agents.test", { withSandbox: true });
});

afterAll(async () => {
	await agents?.dispose();
});

beforeEach(async () => {
	await agents.db.prepare("DELETE FROM workspace_location").run();
});

async function workspace(days: number, currentPlace = "eu") {
	const id = crypto.randomUUID();
	const registry = await agents.registry(id);
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "openai",
		model: "gpt-5",
		instructions: null,
	});
	await registry.saveProviderKey({ provider: "openai", key }, "Ada");
	const started = await registry.startConversation(agent.id, "ada");
	if (!started) throw new Error("Expected a conversation");
	const conversation = await agents.conversation(id, started.id);
	const sandbox = await agents.sandbox(id, started.id);
	await sandbox.takeKeys([["claude-code-session", "old-session"]]);
	await agents.db
		.prepare("INSERT INTO workspace_location VALUES (?, ?, ?, ?)")
		.bind(id, currentPlace, "", Date.now() - days * day)
		.run();
	return {
		id,
		conversationId: started.id,
		registry,
		conversation,
		sandbox,
		location: () =>
			agents.db
				.prepare("SELECT moved_from FROM workspace_location WHERE workspace_id = ?")
				.bind(id)
				.first<{ moved_from: string | null }>(),
	};
}

async function seal(copy: Awaited<ReturnType<typeof workspace>>, sealConversation = true) {
	const token = crypto.randomUUID();
	await copy.registry.moveOut(token, "eu");
	await copy.conversation.moveOut(token, "eu");
	if (sealConversation) await copy.conversation.moveSeal(token, "eu");
	await copy.registry.moveSeal(token, "eu");
	return token;
}

it("forgets an eight-day-old copy and its sandbox keys with the jurisdiction setting unset", async () => {
	const copy = await workspace(8);
	await seal(copy);
	expect(await copy.registry.conversationIds()).toEqual([copy.conversationId]);
	await agents.runScheduled();
	expect(await copy.location()).toEqual({ moved_from: null });
	expect(await copy.registry.conversationIds()).toEqual([]);
	expect(await copy.conversation.transcript()).toBe("[]");
	expect((await copy.conversation.fetch("http://conversation/get-messages")).status).toBe(503);
	expect(await copy.sandbox.moveKeys()).toEqual([]);
});

it("leaves a six-day-old copy sealed with its data and sandbox keys", async () => {
	const copy = await workspace(6);
	await seal(copy);
	const before = await copy.registry.moveDigest();
	await agents.runScheduled();
	expect(await copy.location()).toEqual({ moved_from: "" });
	expect(await copy.registry.moveDigest()).toEqual(before);
	expect(await copy.sandbox.moveKeys()).toEqual([["claude-code-session", "old-session"]]);
});

it("keeps the sealed registry and the old location when a conversation refuses, and retries", async () => {
	const copy = await workspace(8);
	const token = await seal(copy, false);
	await agents.runScheduled();
	expect(await copy.location()).toEqual({ moved_from: "" });
	expect(await copy.registry.conversationIds()).toEqual([copy.conversationId]);
	expect(await copy.sandbox.moveKeys()).toEqual([["claude-code-session", "old-session"]]);
	expect(
		agents.logs.some((log) =>
			log.message.includes(`couldn't forget conversation ${copy.conversationId}`),
		),
	).toBe(true);

	await copy.conversation.moveSeal(token, "eu");
	await agents.runScheduled();
	expect(await copy.location()).toEqual({ moved_from: null });
});

it("skips a row that names its current place even if the objects there are sealed", async () => {
	const copy = await workspace(8, "");
	await seal(copy);
	const before = await copy.registry.moveDigest();
	await agents.runScheduled();
	expect(await copy.location()).toEqual({ moved_from: "" });
	expect(await copy.registry.moveDigest()).toEqual(before);
	expect(await copy.sandbox.moveKeys()).toEqual([["claude-code-session", "old-session"]]);
});

it("forgets a sealed registry that still lists a conversation deleted by the previous release", async () => {
	const copy = await workspace(8);
	await seal(copy);
	await copy.conversation.destroy().catch((error: unknown) => {
		if (!(error instanceof Error) || error.message !== "destroyed") throw error;
	});
	expect(await copy.registry.conversationIds()).toEqual([copy.conversationId]);
	await agents.runScheduled();
	expect(await copy.location()).toEqual({ moved_from: null });
	expect(await copy.registry.conversationIds()).toEqual([]);
	const recreated = await agents.conversation(copy.id, copy.conversationId);
	expect((await recreated.fetch("http://conversation/get-messages")).status).toBe(200);
});

it("gives a younger due copy a turn even when three older copies keep failing", async () => {
	const blocked = [];
	for (const days of [12, 11, 10]) {
		const copy = await workspace(days);
		await seal(copy, false);
		blocked.push(copy);
	}
	const ready = await workspace(8);
	await seal(ready);
	for (let run = 0; run < 30; run++) {
		await agents.runScheduled();
		if ((await ready.location())?.moved_from === null) break;
	}
	expect(await ready.location()).toEqual({ moved_from: null });
	for (const copy of blocked) expect(await copy.location()).toEqual({ moved_from: "" });
});

it("clears the old location on retry when D1 rejected the first update", async () => {
	const copy = await workspace(8);
	await seal(copy);
	await agents.db
		.prepare(`
		CREATE TRIGGER reject_move_forget BEFORE UPDATE OF moved_from ON workspace_location
		BEGIN SELECT RAISE(ABORT, 'update refused'); END
	`)
		.run();
	try {
		await agents.runScheduled();
		expect(await copy.location()).toEqual({ moved_from: "" });
		expect(await copy.registry.moveForget()).toBe("already");
	} finally {
		await agents.db.prepare("DROP TRIGGER reject_move_forget").run();
	}
	await agents.runScheduled();
	expect(await copy.location()).toEqual({ moved_from: null });
});
