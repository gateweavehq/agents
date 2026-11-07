import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { RegistryDO as TestRegistry } from "./worker";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;

const ADA = "user-ada";
const GRACE = "user-grace";
const KEY = "sk-ant-api03-abcdefgh";
const MINUTE = 60 * 1000;

const EVENT = JSON.stringify({ type: "issue.created", data: { title: "Login fails" } });

async function withAgent(stub: Stub) {
	await stub.saveProviderKey({ provider: "anthropic", key: KEY }, ADA);
	return (
		await stub.createAgent({
			name: "Reviewer",
			description: "Reads code",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
		})
	).id;
}

async function conversationOf(stub: Stub, agentId: string, person: string) {
	const conversation = await stub.startConversation(agentId, person);
	if (!conversation) throw new Error("No conversation");
	return conversation.id;
}

async function begin(stub: Stub, conversation: string, ...via: [] | [TurnVia]) {
	const turn = await stub.beginTurn(conversation, "Hello", ...via);
	if ("status" in turn) throw new Error(turn.message);
	return turn;
}
type TurnVia = NonNullable<Parameters<Stub["beginTurn"]>[2]>;

const destroyed = (stub: Stub) =>
	runInDurableObject(stub, (instance: TestRegistry) => instance.destroyedConversations());

const refuseToDestroy = (stub: Stub, ...ids: string[]) =>
	runInDurableObject(stub, (instance: TestRegistry) => instance.refuseToDestroy(ids));

/** Moves a waiting conversation's next try to now, as if the wait had passed. */
const waitPassed = (stub: Stub) =>
	runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE conversations_to_destroy SET next_attempt_at = 0");
	});

const alarmAt = (stub: Stub) =>
	runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

/**
 * Waits for the alarm, which is real here and fires by itself. So the tests run one where they need
 * it to have come, and wait for what they expect, since it may be under way already.
 */
async function alarmHasDestroyed(stub: Stub, ids: string[]) {
	await runDurableObjectAlarm(stub);
	await vi.waitFor(async () => {
		expect((await destroyed(stub)).sort()).toEqual([...ids].sort());
	});
}

const alarmIsDone = (stub: Stub) =>
	vi.waitFor(async () => {
		expect(await alarmAt(stub)).toBeNull();
	});

/** Sets off an alarm whatever is due, and waits until it has run and set the next one. */
async function alarmAgain(stub: Stub) {
	await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now()));
	await runDurableObjectAlarm(stub);
	await vi.waitFor(async () => {
		const at = (await alarmAt(stub)) ?? 0;
		expect(at === 0 || at > Date.now()).toBe(true);
	});
}

async function sign(secret: string, id: string, timestamp: string, body: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${id}.${timestamp}.${body}`),
	);
	return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

describe("forgetting a person", () => {
	it("takes their conversations out of the index at once and destroys them on the alarm", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const theirs = await conversationOf(stub, agent, ADA);
		const another = await conversationOf(stub, agent, ADA);
		const someoneElses = await conversationOf(stub, agent, GRACE);

		await stub.forgetPerson(ADA);

		expect(await stub.listConversations(ADA)).toEqual([]);
		expect(await stub.getConversation(theirs, ADA)).toBeNull();

		await alarmHasDestroyed(stub, [theirs, another]);

		expect(await stub.conversationIds()).toEqual([someoneElses]);
		expect((await stub.listConversations(GRACE)).map(({ id }) => id)).toEqual([someoneElses]);
		// Nothing is left to do, so the alarm doesn't come back for this.
		await alarmIsDone(stub);
	});

	it("keeps their runs for usage, without the conversation, under their id", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const conversation = await conversationOf(stub, agent, ADA);
		const { runId } = await begin(stub, conversation);

		await stub.forgetPerson(ADA);

		expect(await stub.getRun(runId)).toMatchObject({ conversationId: null, startedBy: ADA });
		expect(await stub.runUsage(0)).toMatchObject({ runs: 1 });
	});

	it("destroys the conversations their team's nested turns ran in", async () => {
		const stub = registry();
		const lead = await withAgent(stub);
		const coder = (
			await stub.createAgent({
				name: "Coder",
				description: "Writes code",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				instructions: null,
			})
		).id;
		const team = (await stub.createTeam({ name: "Builders", description: null, lead })).id;
		await stub.setTeamGraph(team, {
			lead,
			members: [
				{ kind: "agent", id: lead },
				{ kind: "agent", id: coder },
			],
			edges: [{ from: lead, to: coder, kind: "delegate" }],
		});
		const root = (await stub.startTeamConversation(team, ADA))?.id ?? "";
		const parent = await begin(stub, root);
		const nested = crypto.randomUUID();
		await begin(stub, nested, {
			parentRunId: parent.runId,
			parentSpanId: crypto.randomUUID(),
			kind: "delegate",
			team,
			to: coder,
		});
		expect((await stub.conversationIds()).sort()).toEqual([root, nested].sort());

		await stub.forgetPerson(ADA);
		await alarmHasDestroyed(stub, [root, nested]);

		expect(await stub.conversationIds()).toEqual([]);
	});

	it("leaves a conversation a trigger started, and what they set up", async () => {
		const stub = registry();
		const agentId = await withAgent(stub);
		const { trigger, secret } = await (async () => {
			const made = await stub.createTrigger(
				{
					name: "New issues",
					prompt: "Triage this: {{data.title}}",
					target: { kind: "agent", agentId },
				},
				ADA,
			);
			if ("status" in made) throw new Error(made.message);
			return made;
		})();
		const id = crypto.randomUUID();
		const timestamp = String(Math.floor(Date.now() / 1000));
		const receipt = await stub.receiveTrigger(
			trigger.id,
			{ id, timestamp, signature: await sign(secret, id, timestamp, EVENT) },
			EVENT,
		);
		if (receipt.status !== "start") throw new Error(`The delivery was ${receipt.status}`);

		await stub.forgetPerson(ADA);
		await runDurableObjectAlarm(stub);

		expect(await destroyed(stub)).toEqual([]);
		expect(await stub.conversationIds()).toEqual([receipt.conversationId]);
		expect((await stub.listTriggers()).map((entry) => entry.id)).toEqual([trigger.id]);
		expect(await stub.listProviderKeys()).toHaveLength(1);
		expect(await stub.getAgent(agentId)).not.toBeNull();
	});

	it("can be asked again without harm", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const conversation = await conversationOf(stub, agent, ADA);

		await stub.forgetPerson(ADA);
		await stub.forgetPerson(ADA);
		await alarmHasDestroyed(stub, [conversation]);
		await stub.forgetPerson(ADA);

		expect(await destroyed(stub)).toEqual([conversation]);
		await alarmIsDone(stub);
	});

	it("goes on past one that fails, and tries it again later, for as long as it takes", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const stuck = await conversationOf(stub, agent, ADA);
		const fine = await conversationOf(stub, agent, ADA);
		await refuseToDestroy(stub, stuck);

		const before = Date.now();
		await stub.forgetPerson(ADA);
		await alarmHasDestroyed(stub, [fine]);

		await vi.waitFor(async () => {
			expect((await alarmAt(stub)) ?? 0).toBeGreaterThanOrEqual(before + MINUTE);
		});
		// Still known, so a workspace deleted meanwhile can reach it.
		expect(await stub.conversationIds()).toEqual([stuck]);

		// Not yet due: an alarm for something else leaves it waiting.
		await alarmAgain(stub);
		expect(await destroyed(stub)).toEqual([fine]);

		// Twice as long as the first wait, because it failed again.
		const again = Date.now();
		await waitPassed(stub);
		await alarmAgain(stub);
		expect((await alarmAt(stub)) ?? 0).toBeGreaterThanOrEqual(again + 2 * MINUTE);

		await refuseToDestroy(stub);
		await waitPassed(stub);
		await alarmAgain(stub);
		await alarmHasDestroyed(stub, [stuck, fine]);
		expect(await stub.conversationIds()).toEqual([]);
		await alarmIsDone(stub);
	});

	it("works through many over several alarms", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const ids: string[] = [];
		for (let i = 0; i < 25; i++) ids.push(await conversationOf(stub, agent, ADA));

		await stub.forgetPerson(ADA);
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(stub);
			expect((await destroyed(stub)).sort()).toEqual([...ids].sort());
		});

		const alarms = await runInDurableObject(stub, (instance: TestRegistry) =>
			instance.destroyedPerAlarm(),
		);
		expect(Math.max(...alarms)).toBe(10);
		expect(alarms.filter((count) => count > 0).length).toBeGreaterThanOrEqual(3);
		await alarmIsDone(stub);
	});

	it("leaves a registry alone that never heard of them", async () => {
		const stub = registry();
		const agent = await withAgent(stub);
		const conversation = await conversationOf(stub, agent, GRACE);

		await stub.forgetPerson(ADA);

		expect(await stub.conversationIds()).toEqual([conversation]);
		expect(await alarmAt(stub)).toBeNull();
	});
});
