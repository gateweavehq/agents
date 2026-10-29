import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { nextScheduledRun, TRIGGER_LIMITS, type TriggerInput } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;
// A refusal thrown over RPC is also reported as unhandled, so those calls are made inside.
const inside = <T>(stub: Stub, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

const ADA = "user-ada";
const KEY = "sk-ant-api03-abcdefgh";
const EVENT = JSON.stringify({ type: "issue.created", data: { title: "Login fails" } });

async function withAgent(stub: Stub, name = "Triager") {
	return (
		await stub.createAgent({
			name,
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
		})
	).id;
}

/** Makes a trigger, failing the test when it is refused. */
async function create(stub: Stub, input: TriggerInput) {
	const made = await stub.createTrigger(input, ADA);
	if ("status" in made) throw new Error(made.message);
	return made;
}

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

async function deliver(
	stub: Stub,
	triggerId: string,
	secret: string,
	{ id = crypto.randomUUID(), body = EVENT, at = Date.now() } = {},
) {
	const timestamp = String(Math.floor(at / 1000));
	const signature = await sign(secret, id, timestamp, body);
	return stub.receiveTrigger(triggerId, { id, timestamp, signature }, body);
}

/** Delivers an event and begins its run, as the gateway and the runtime do. */
async function run(stub: Stub, triggerId: string, secret: string, id?: string) {
	const receipt = await deliver(stub, triggerId, secret, { id });
	if (receipt.status !== "start") throw new Error(`The delivery was ${receipt.status}`);
	const turn = await stub.beginTriggerTurn(receipt.conversationId, receipt.text);
	if ("status" in turn) throw new Error(turn.message);
	return { receipt, turn };
}

describe("triggers", () => {
	it("start a run of their agent for each event, once", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const agentId = await withAgent(stub);
		const { trigger, secret } = await create(stub, {
			name: "New issues",
			prompt: "Triage this issue: {{data.title}}",
			target: { kind: "agent", agentId },
		});
		expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(trigger).toMatchObject({
			name: "New issues",
			targetName: "Triager",
			active: true,
			perDay: TRIGGER_LIMITS.defaultPerDay,
			secretStart: secret.slice(0, 10),
		});
		expect(JSON.stringify(trigger)).not.toContain(secret.slice(10));

		const id = crypto.randomUUID();
		const receipt = await deliver(stub, trigger.id, secret, { id });
		if (receipt.status !== "start") throw new Error(`The delivery was ${receipt.status}`);
		expect(receipt.text.startsWith("Triage this issue: Login fails\n\n")).toBe(true);
		expect(receipt.text).toContain(EVENT);
		// Until its run begins, a retry is asked to come back: that run may yet fail to begin.
		const early = await deliver(stub, trigger.id, secret, { id });
		expect(early).toMatchObject({ status: "starting" });
		expect(early.status === "starting" && early.retryAfter).toBeLessThanOrEqual(60);

		const turn = await stub.beginTriggerTurn(receipt.conversationId, receipt.text);
		if ("status" in turn) throw new Error(turn.message);
		expect(turn).toMatchObject({ key: KEY, agent: { name: "Triager" } });
		expect(await stub.getRun(turn.runId)).toMatchObject({
			startedBy: `trigger:${trigger.id}`,
			triggerId: trigger.id,
			triggerName: "New issues",
			conversationId: receipt.conversationId,
		});

		// A retry of the event starts nothing more.
		expect(await deliver(stub, trigger.id, secret, { id })).toEqual({
			status: "duplicate",
			runId: turn.runId,
		});
		expect(await stub.beginTriggerTurn(receipt.conversationId, receipt.text)).toEqual({
			status: "refused",
			message: "This delivery has had its run already",
		});
		const [listed] = await stub.listTriggers({ kind: "agent", agentId });
		expect(listed?.deliveries).toEqual([
			expect.objectContaining({ id, status: "started", event: "issue.created", runId: turn.runId }),
		]);

		// The conversation is nobody's: no member lists it, or goes on with it.
		expect(await stub.listConversations(ADA)).toEqual([]);
		expect(await stub.beginTurn(receipt.conversationId, "And another thing")).toEqual({
			status: "refused",
			message: "This conversation was started by a trigger, so it cannot go on",
		});
	});

	it("refuse deliveries their secret did not sign", async () => {
		const stub = registry();
		const agentId = await withAgent(stub);
		const { trigger, secret } = await create(stub, {
			name: "New issues",
			prompt: "Triage it",
			target: { kind: "agent", agentId },
		});
		const other = (
			await create(stub, { name: "Other", prompt: "Triage it", target: { kind: "agent", agentId } })
		).secret;

		expect(await deliver(stub, trigger.id, other)).toEqual({ status: "unauthorized" });
		const stale = Date.now() - (TRIGGER_LIMITS.toleranceSeconds + 60) * 1000;
		expect(await deliver(stub, trigger.id, secret, { at: stale })).toEqual({
			status: "unauthorized",
		});
		const id = crypto.randomUUID();
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = await sign(secret, id, timestamp, EVENT);
		expect(
			await stub.receiveTrigger(trigger.id, { id, timestamp, signature }, `${EVENT} `),
		).toEqual({ status: "unauthorized" });
		expect(
			await stub.receiveTrigger(trigger.id, { id, timestamp, signature: "v1,bm9wZQ==" }, EVENT),
		).toEqual({ status: "unauthorized" });
		expect(await deliver(stub, "no-such-trigger", secret)).toEqual({ status: "not_found" });

		// Among several signatures, as a sender rotating its secret sends, one is enough.
		const both = `v1,bm9wZQ== ${signature}`;
		expect(
			await stub.receiveTrigger(trigger.id, { id, timestamp, signature: both }, EVENT),
		).toMatchObject({ status: "start" });
		const listed = (await stub.listTriggers()).find((each) => each.id === trigger.id);
		expect(listed?.deliveries.map((delivery) => delivery.id)).toEqual([id]);
	});

	it("hold each trigger to its runs a day and a minute", async () => {
		const stub = registry();
		const agentId = await withAgent(stub);
		const daily = await create(stub, {
			name: "Twice a day",
			prompt: "Triage it",
			target: { kind: "agent", agentId },
			perDay: 2,
		});
		expect(await deliver(stub, daily.trigger.id, daily.secret)).toMatchObject({ status: "start" });
		expect(await deliver(stub, daily.trigger.id, daily.secret)).toMatchObject({ status: "start" });
		const over = await deliver(stub, daily.trigger.id, daily.secret);
		expect(over).toMatchObject({
			status: "limited",
			message: "The trigger started its 2 runs for the day",
		});
		expect(over.status === "limited" && over.retryAfter).toBeGreaterThan(23 * 60 * 60);

		const busy = await create(stub, {
			name: "Busy",
			prompt: "Triage it",
			target: { kind: "agent", agentId },
		});
		for (let i = 0; i < TRIGGER_LIMITS.perMinute; i++) {
			expect(await deliver(stub, busy.trigger.id, busy.secret)).toMatchObject({ status: "start" });
		}
		const id = crypto.randomUUID();
		const limited = await deliver(stub, busy.trigger.id, busy.secret, { id });
		expect(limited).toMatchObject({ status: "limited" });
		expect(limited.status === "limited" && limited.retryAfter).toBeLessThanOrEqual(60);
		const [listed] = await stub.listTriggers({ kind: "agent", agentId });
		expect(listed?.deliveries[0]).toMatchObject({ id, status: "limited" });
	});

	it("start the lead of their team, in a conversation with the team", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const lead = await withAgent(stub, "Planner");
		const coder = await withAgent(stub, "Coder");
		const teamId = (await stub.createTeam({ name: "Builders", description: null, lead })).id;
		await stub.setTeamGraph(teamId, {
			lead,
			members: [
				{ kind: "agent", id: lead },
				{ kind: "agent", id: coder },
			],
			edges: [{ from: lead, to: coder, kind: "delegate" }],
		});
		const { trigger, secret } = await create(stub, {
			name: "Releases",
			prompt: "Plan the release",
			target: { kind: "team", teamId },
		});
		expect(trigger).toMatchObject({ target: { kind: "team", teamId }, targetName: "Builders" });

		const { turn } = await run(stub, trigger.id, secret);
		expect(turn.agent.name).toBe("Planner");
		expect(turn.edges).toHaveLength(1);
		expect(await stub.getRun(turn.runId)).toMatchObject({
			teamPath: [teamId],
			triggerName: "Releases",
		});

		// They go with the team.
		await stub.deleteTeam(teamId);
		expect(await stub.listTriggers()).toEqual([]);
		expect(await stub.getRun(turn.runId)).toMatchObject({
			triggerId: trigger.id,
			triggerName: null,
		});
	});

	it("skip events while paused, and take again ones whose run could not begin", async () => {
		const stub = registry();
		const agentId = await withAgent(stub);
		const { trigger, secret } = await create(stub, {
			name: "New issues",
			prompt: "Triage it",
			target: { kind: "agent", agentId },
		});
		await stub.updateTrigger(trigger.id, { active: false });
		const paused = crypto.randomUUID();
		expect(await deliver(stub, trigger.id, secret, { id: paused })).toEqual({ status: "skipped" });
		await stub.updateTrigger(trigger.id, { active: true });
		// What came while it was paused stays skipped.
		expect(await deliver(stub, trigger.id, secret, { id: paused })).toEqual({
			status: "duplicate",
			runId: null,
		});

		// With no key, the run cannot begin; a retry once there is one starts it.
		const id = crypto.randomUUID();
		const first = await deliver(stub, trigger.id, secret, { id });
		if (first.status !== "start") throw new Error(`The delivery was ${first.status}`);
		expect(await stub.beginTriggerTurn(first.conversationId, first.text)).toMatchObject({
			status: "refused",
		});
		const [failed] = await stub.listTriggers({ kind: "agent", agentId });
		expect(failed?.deliveries[0]).toMatchObject({ id, status: "failed", runId: null });

		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const { receipt, turn } = await run(stub, trigger.id, secret, id);
		expect(receipt.conversationId).not.toBe(first.conversationId);
		expect(await stub.getRun(turn.runId)).toMatchObject({ triggerId: trigger.id });
	});

	it("start only on the event types they are limited to, and skip the rest", async () => {
		const stub = registry();
		const agentId = await withAgent(stub);
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const { trigger, secret } = await create(stub, {
			name: "New issues",
			prompt: "Triage it",
			target: { kind: "agent", agentId },
			events: ["issue.created"],
		});
		expect(trigger.events).toEqual(["issue.created"]);

		const changed = crypto.randomUUID();
		const update = JSON.stringify({ type: "issue.updated", data: { title: "Login fails" } });
		expect(await deliver(stub, trigger.id, secret, { id: changed, body: update })).toEqual({
			status: "skipped",
		});
		expect(await deliver(stub, trigger.id, secret, { body: '{"data":{}}' })).toEqual({
			status: "skipped",
		});
		const [entry] = await stub.listTriggers();
		// Both may come in the same millisecond, so in either order.
		expect(entry?.deliveries.map(({ status, event, error }) => ({ status, event, error }))).toEqual(
			expect.arrayContaining([
				{
					status: "skipped",
					event: null,
					error: "It starts runs on issue.created only, and the event has no type",
				},
				{
					status: "skipped",
					event: "issue.updated",
					error: "It starts runs on issue.created only, not issue.updated",
				},
			]),
		);
		expect(entry?.deliveries).toHaveLength(2);
		await run(stub, trigger.id, secret);

		// Taking every event again starts on any type, but what was skipped stays skipped.
		expect(await stub.updateTrigger(trigger.id, { events: null })).toMatchObject({ events: null });
		expect(await deliver(stub, trigger.id, secret, { id: changed, body: update })).toEqual({
			status: "duplicate",
			runId: null,
		});
		expect(await deliver(stub, trigger.id, secret, { body: update })).toMatchObject({
			status: "start",
		});
	});

	it("refuse event lists that are empty, repeated or not event types", async () => {
		const stub = registry();
		const agentId = await withAgent(stub);
		const input = {
			name: "New issues",
			prompt: "Triage it",
			target: { kind: "agent" as const, agentId },
		};
		for (const [events, message] of [
			[[], "Name at least one event type, or take every event"],
			[["issue.created", "issue.created"], "An event type is listed twice"],
			[["issue created"], "Write event types as the sender names them, such as issue.created"],
		] as const) {
			await expect(
				inside(stub, (instance) => instance.createTrigger({ ...input, events: [...events] }, ADA)),
			).rejects.toThrow(message);
		}
		expect(await stub.listTriggers()).toEqual([]);
	});

	it("take the sender's own secret, or a new one, in place of the old", async () => {
		const stub = registry();
		const agentId = await withAgent(stub);
		const { trigger, secret } = await create(stub, {
			name: "New issues",
			prompt: "Triage it",
			target: { kind: "agent", agentId },
		});
		const senders = `whsec_${btoa("a sender's secret, 32 bytes long")}`;
		const replaced = await stub.replaceTriggerSecret(trigger.id, senders);
		expect(replaced).toMatchObject({ secret: senders, trigger: { secretStart: "whsec_YSBz" } });
		expect(await deliver(stub, trigger.id, secret)).toEqual({ status: "unauthorized" });
		expect(await deliver(stub, trigger.id, senders)).toMatchObject({ status: "start" });

		const fresh = await stub.replaceTriggerSecret(trigger.id);
		if (!fresh || "status" in fresh) throw new Error("The secret was not replaced");
		expect(fresh.secret).not.toBe(senders);
		expect(await deliver(stub, trigger.id, fresh.secret)).toMatchObject({ status: "start" });

		await expect(
			inside(stub, (instance) => instance.replaceTriggerSecret(trigger.id, "not-a-secret")),
		).rejects.toThrow("Paste the whole secret");
		expect(await stub.replaceTriggerSecret("no-such-trigger")).toBeNull();
	});

	it("start only live agents run by Gateweave, and keep their runs when deleted", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const agentId = await withAgent(stub);
		const gone = await withAgent(stub, "Gone");
		await stub.removeAgent(gone);
		expect(
			await stub.createTrigger(
				{ name: "Nope", prompt: "Triage it", target: { kind: "agent", agentId: gone } },
				ADA,
			),
		).toEqual({ status: "refused", message: "That agent was removed or is not run by Gateweave" });
		expect(
			await stub.createTrigger(
				{ name: "Nope", prompt: "Triage it", target: { kind: "team", teamId: "no-such-team" } },
				ADA,
			),
		).toEqual({ status: "refused", message: "That team was deleted" });

		const { trigger, secret } = await create(stub, {
			name: "New issues",
			prompt: "Triage it",
			target: { kind: "agent", agentId },
		});
		const { turn } = await run(stub, trigger.id, secret);
		expect(await stub.deleteTrigger(trigger.id)).toBe(true);
		expect(await stub.deleteTrigger(trigger.id)).toBe(false);
		expect(await deliver(stub, trigger.id, secret)).toEqual({ status: "not_found" });
		expect(await stub.getRun(turn.runId)).toMatchObject({
			triggerId: trigger.id,
			triggerName: null,
		});
	});
});

describe("scheduled triggers", () => {
	const WEEKDAYS = { cron: "0 9 * * 1-5", timeZone: "Europe/Istanbul" };

	/** Makes the trigger's next run due a minute ago, as if the time had come. */
	const makeDue = (stub: Stub, triggerId: string, at = Date.now() - 60_000) =>
		runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE triggers SET next_run_at = ? WHERE id = ?", at, triggerId);
			return at;
		});

	async function scheduled(stub: Stub, input: Partial<TriggerInput> = {}) {
		const agentId = await withAgent(stub);
		const made = await create(stub, {
			name: "Standup",
			prompt: "Sum up what changed since {{data.scheduledFor}}",
			target: { kind: "agent", agentId },
			schedule: WEEKDAYS,
			...input,
		});
		return { ...made, agentId };
	}

	it("start a run when their time comes, once for each time", async () => {
		const name = crypto.randomUUID();
		const stub = env.REGISTRY.getByName(name);
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const before = Date.now();
		const { trigger } = await scheduled(stub);
		expect(trigger).toMatchObject({ schedule: WEEKDAYS, events: null, active: true });
		expect(trigger.nextRunAt).toBe(nextScheduledRun(WEEKDAYS, trigger.createdAt));
		expect(trigger.nextRunAt).toBeGreaterThan(before);

		// The app's registry finds its workspace by the name it was reached by.
		expect(await runInDurableObject(stub, (_instance, state) => state.id.name)).toBe(name);
		const due = await makeDue(stub, trigger.id);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const [started, ...more] = await stub.startedTurns();
		expect(more).toEqual([]);
		const scheduledFor = new Date(due).toISOString();
		expect(started?.text).toMatch(new RegExp(`^Sum up what changed since ${scheduledFor}\n`));
		const [listed] = await stub.listTriggers();
		expect(listed?.deliveries).toMatchObject([
			{ id: `schedule:${due}`, event: "schedule", status: "started" },
		]);
		// The next run counts from now, not from the time that was due.
		expect(listed?.nextRunAt).toBe(
			nextScheduledRun(WEEKDAYS, listed?.deliveries[0]?.receivedAt ?? 0),
		);

		// An alarm that comes again for the same time starts nothing more.
		await makeDue(stub, trigger.id, due);
		await runDurableObjectAlarm(stub);
		expect(await stub.startedTurns()).toHaveLength(1);
	});

	it("name the run's conversation for the trigger, and note a run that could not begin", async () => {
		const stub = registry();
		const { trigger } = await scheduled(stub);
		await makeDue(stub, trigger.id);
		await runDurableObjectAlarm(stub);
		// No key for the agent's provider, so the run could not begin.
		const [listed] = await stub.listTriggers();
		expect(listed?.deliveries[0]).toMatchObject({ status: "failed", runId: null });
		expect(listed?.deliveries[0]?.error).toMatch(/key/i);
		const [started] = await stub.startedTurns();
		const title = await runInDurableObject(
			stub,
			(_instance, state) =>
				state.storage.sql
					.exec<{ title: string }>(
						"SELECT title FROM conversations WHERE id = ?",
						started?.conversationId ?? "",
					)
					.one().title,
		);
		expect(title).toBe("Standup");
	});

	it("start nothing while paused, and count from the time they are resumed", async () => {
		const stub = registry();
		const { trigger } = await scheduled(stub);
		const paused = await stub.updateTrigger(trigger.id, { active: false });
		expect(paused).toMatchObject({ active: false, nextRunAt: null });
		await runDurableObjectAlarm(stub);
		expect(await stub.startedTurns()).toEqual([]);

		const resumedAt = Date.now();
		const resumed = await stub.updateTrigger(trigger.id, { active: true });
		expect(resumed?.nextRunAt).toBe(nextScheduledRun(WEEKDAYS, resumed?.updatedAt ?? 0));
		expect(resumed?.nextRunAt).toBeGreaterThan(resumedAt);
	});

	it("hold their runs to the runs a day", async () => {
		const stub = registry();
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const { trigger } = await scheduled(stub, { perDay: 1 });
		await makeDue(stub, trigger.id, Date.now() - 120_000);
		await runDurableObjectAlarm(stub);
		await makeDue(stub, trigger.id, Date.now() - 60_000);
		await runDurableObjectAlarm(stub);
		expect(await stub.startedTurns()).toHaveLength(1);
		const [listed] = await stub.listTriggers();
		expect(listed?.deliveries.map((delivery) => delivery.status)).toEqual(["limited", "started"]);
	});

	it("take no webhooks, and take them again once the schedule is taken away", async () => {
		const stub = registry();
		const { trigger, secret } = await scheduled(stub);
		expect(await deliver(stub, trigger.id, secret)).toEqual({ status: "not_found" });

		const changed = await stub.updateTrigger(trigger.id, { schedule: null });
		expect(changed).toMatchObject({ schedule: null, nextRunAt: null });
		expect(await deliver(stub, trigger.id, secret)).toMatchObject({ status: "start" });

		const again = await stub.updateTrigger(trigger.id, {
			schedule: { cron: "30 18 * * 5", timeZone: "UTC" },
		});
		expect(again).toMatchObject({ events: null });
		expect(new Date(again?.nextRunAt ?? 0).getUTCDay()).toBe(5);
	});
});
