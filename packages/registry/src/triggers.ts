/**
 * Triggers: inbound webhooks that start a run of an agent run by Gateweave, or of a team's lead,
 * in a conversation of the delivery's own, with no person in it. The app's gateway hands each
 * delivery to the registry, which checks its Standard Webhooks signature with the trigger's secret,
 * keeps one row per `webhook-id` so a retry starts nothing twice, and holds each trigger to its
 * runs per minute and per day. The runtime then begins the run (`beginTriggerTurn`).
 *
 * A scheduled trigger takes no webhooks: the registry's alarm wakes when its next run is due
 * (`dueSchedules`), and the run is admitted the same way, under the same limits.
 */
import {
	eventType,
	labelSkip,
	nextScheduledRun,
	SCHEDULE_EVENT,
	scheduleEvent,
	TRIGGER_LIMITS,
	TRIGGER_SECRET_PREFIX,
	type Trigger,
	type TriggerDelivery,
	type TriggerEntry,
	type TriggerHeaders,
	type TriggerSchedule,
	type TriggerTarget,
	triggerMessage,
	triggerStarter,
} from "@gateweave/agents-model";
import { and, count, desc, eq, gte, inArray, isNull, lt, lte, min } from "drizzle-orm";
import {
	agentDefinitions,
	agents,
	conversations,
	teams,
	triggerDeliveries,
	triggers,
} from "./db/schema";
import type { Db } from "./state";
import { teamLead } from "./teams";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Deliveries are kept this long, which is how long a retry of one is known. */
export const DELIVERY_RETENTION = 7 * DAY;

/**
 * A delivery taken but whose run never began, as when the Worker stopped in between, is taken
 * again on a retry after this long.
 */
export const ACCEPT_TIMEOUT = MINUTE;

/** Signatures of one delivery looked at, at most: senders rotating secrets send two. */
const MAX_SIGNATURES = 5;

/** Where a trigger's secret is sealed. */
export function triggerPlace(triggerId: string): string {
	return `trigger:${triggerId}`;
}

/** A new secret, as Standard Webhooks writes them: `whsec_` and 32 random bytes in base64. */
export function newTriggerSecret(): string {
	let binary = "";
	for (const byte of crypto.getRandomValues(new Uint8Array(32)))
		binary += String.fromCharCode(byte);
	return `${TRIGGER_SECRET_PREFIX}${btoa(binary)}`;
}

/** The start of a secret, which pages show to tell secrets apart. */
export function secretStartOf(secret: string): string {
	return secret.slice(0, TRIGGER_SECRET_PREFIX.length + 4);
}

/**
 * Whether a delivery is signed with `secret`, per Standard Webhooks: an HMAC-SHA256 of
 * `id.timestamp.body` under the secret's key, among the `v1,` signatures of the header, with a
 * timestamp near `now`. WebCrypto's `verify` compares in constant time.
 */
export async function verifyDelivery(
	secret: string,
	headers: TriggerHeaders,
	body: string,
	now: number,
): Promise<boolean> {
	if (!/^\d{1,12}$/.test(headers.timestamp)) return false;
	if (Math.abs(now / 1000 - Number(headers.timestamp)) > TRIGGER_LIMITS.toleranceSeconds) {
		return false;
	}
	const raw = fromBase64(secret.slice(TRIGGER_SECRET_PREFIX.length));
	if (!secret.startsWith(TRIGGER_SECRET_PREFIX) || !raw) return false;
	const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
		"verify",
	]);
	const signed = new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${body}`);
	const candidates = headers.signature.split(" ").slice(0, MAX_SIGNATURES);
	for (const candidate of candidates) {
		const [version, signature] = candidate.split(",");
		const bytes = version === "v1" && signature ? fromBase64(signature) : null;
		if (bytes && (await crypto.subtle.verify("HMAC", key, bytes, signed))) return true;
	}
	return false;
}

/** The workspace's triggers, the newest first, with their latest deliveries; or one target's. */
export function listTriggers(db: Db, target?: TriggerTarget): TriggerEntry[] {
	const rows = selectTriggers(db)
		.where(
			target === undefined
				? undefined
				: target.kind === "agent"
					? eq(triggers.agentId, target.agentId)
					: eq(triggers.teamId, target.teamId),
		)
		.orderBy(desc(triggers.createdAt))
		.all();
	return rows.map((row) => ({
		...toTrigger(row),
		deliveries: latestDeliveries(db, row.trigger.id),
	}));
}

export function getTrigger(db: Db, id: string): Trigger | null {
	const row = selectTriggers(db).where(eq(triggers.id, id)).get();
	return row ? toTrigger(row) : null;
}

/** The trigger's row, secret and all, for the registry alone. */
export function triggerRow(db: Db, id: string) {
	return db.select().from(triggers).where(eq(triggers.id, id)).get() ?? null;
}

/**
 * Why a trigger cannot start `target` now, if it cannot: an agent must be a live agent run by
 * Gateweave, and a team must have a lead that is one.
 */
export function targetRefusal(db: Db, target: TriggerTarget): string | null {
	if (target.kind === "team") {
		const team = teamLead(db, target.teamId);
		if (!team) return "That team was deleted";
		return runnable(db, team.leadAgentId) ? null : `The lead of ${team.name} was removed`;
	}
	return runnable(db, target.agentId) ? null : "That agent was removed or is not run by Gateweave";
}

/** Why the workspace cannot have another trigger, if it has as many as it may. */
export function triggerCapRefusal(db: Db): string | null {
	const existing = db.select({ n: count() }).from(triggers).get()?.n ?? 0;
	return existing >= TRIGGER_LIMITS.perWorkspace
		? `A workspace can have up to ${TRIGGER_LIMITS.perWorkspace} triggers`
		: null;
}

/** Adds a trigger with its secret sealed, unless the workspace has as many as it may. */
export function insertTrigger(
	db: Db,
	row: {
		id: string;
		name: string;
		prompt: string;
		target: TriggerTarget;
		perDay: number;
		events: string[] | null;
		label: string | null;
		schedule: TriggerSchedule | null;
		sealed: string;
		secretStart: string;
		createdBy: string;
	},
	now: number,
): Trigger | { refused: string } {
	const full = triggerCapRefusal(db);
	if (full) return { refused: full };
	const refusal = targetRefusal(db, row.target);
	if (refusal) return { refused: refusal };
	const { target, ...rest } = row;
	db.insert(triggers)
		.values({
			...rest,
			agentId: target.kind === "agent" ? target.agentId : null,
			teamId: target.kind === "team" ? target.teamId : null,
			active: true,
			// A scheduled trigger has no label, as it has no event types.
			label: row.schedule ? null : row.label,
			nextRunAt: row.schedule && nextScheduledRun(row.schedule, now),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const trigger = getTrigger(db, row.id);
	if (!trigger) throw new Error("A trigger just added is missing");
	return trigger;
}

export function updateTrigger(
	db: Db,
	id: string,
	patch: {
		name?: string;
		prompt?: string;
		perDay?: number;
		events?: string[] | null;
		label?: string | null;
		schedule?: TriggerSchedule | null;
		active?: boolean;
	},
	now: number,
): Trigger | null {
	const current = db
		.select({ schedule: triggers.schedule, active: triggers.active })
		.from(triggers)
		.where(eq(triggers.id, id))
		.get();
	if (!current) return null;
	const schedule = patch.schedule === undefined ? current.schedule : patch.schedule;
	const active = patch.active ?? current.active;
	// A schedule given, changed or resumed counts from now: a resumed one does not run at once for
	// a time it missed while paused.
	const timing =
		patch.schedule === undefined && patch.active === undefined
			? {}
			: { nextRunAt: active && schedule ? nextScheduledRun(schedule, now) : null };
	// A schedule's runs all start the same way, so it has no event types and no label.
	const webhookOnly = schedule ? { events: null, label: null } : {};
	db.update(triggers)
		.set({ ...patch, ...timing, ...webhookOnly, updatedAt: now })
		.where(eq(triggers.id, id))
		.run();
	return getTrigger(db, id);
}

export function replaceSecret(
	db: Db,
	id: string,
	sealed: string,
	secretStart: string,
	now: number,
): Trigger | null {
	const updated = db
		.update(triggers)
		.set({ sealed, secretStart, updatedAt: now })
		.where(eq(triggers.id, id))
		.returning({ id: triggers.id })
		.get();
	return updated ? getTrigger(db, id) : null;
}

/**
 * Deletes a trigger and what came to it. The conversations and runs it started stay, as a person's
 * do when a team they talked to is deleted.
 */
export function deleteTrigger(db: Db, id: string): boolean {
	db.delete(triggerDeliveries).where(eq(triggerDeliveries.triggerId, id)).run();
	const deleted = db
		.delete(triggers)
		.where(eq(triggers.id, id))
		.returning({ id: triggers.id })
		.get();
	return deleted !== undefined;
}

/** Deletes a team's triggers, as the team is deleted. */
export function deleteTeamTriggers(db: Db, teamId: string): void {
	const ids = db
		.select({ id: triggers.id })
		.from(triggers)
		.where(eq(triggers.teamId, teamId))
		.all()
		.map((row) => row.id);
	if (ids.length === 0) return;
	db.delete(triggerDeliveries).where(inArray(triggerDeliveries.triggerId, ids)).run();
	db.delete(triggers).where(inArray(triggers.id, ids)).run();
}

/** Active scheduled triggers whose next run is due. */
export function dueSchedules(db: Db, now: number) {
	return db
		.select()
		.from(triggers)
		.where(and(eq(triggers.active, true), lte(triggers.nextRunAt, now)))
		.all();
}

/** When the next scheduled run is due, of any active trigger; null when none is. */
export function nextScheduleAt(db: Db): number | null {
	return (
		db
			.select({ at: min(triggers.nextRunAt) })
			.from(triggers)
			.where(eq(triggers.active, true))
			.get()?.at ?? null
	);
}

/** What a schedule's run came to: started, with its message, or what `admitDelivery` said. */
export type ScheduledAdmission =
	| Exclude<Admission, { status: "start" }>
	| { status: "start"; conversationId: string; text: string };

/**
 * Admits the run a schedule is due for, as a webhook's delivery is, with the time it was due as
 * the delivery's id, so an alarm run twice starts it once. The next run counts from now: a
 * schedule the alarm reached late runs once, not once for each time it missed.
 */
export function admitScheduledRun(
	db: Db,
	trigger: NonNullable<ReturnType<typeof triggerRow>>,
	now: number,
): ScheduledAdmission {
	const { schedule, nextRunAt } = trigger;
	if (!schedule || nextRunAt === null) return { status: "skipped" };
	const body = scheduleEvent(schedule, nextRunAt);
	const admitted = admitDelivery(db, trigger, { id: `schedule:${nextRunAt}`, body }, now);
	db.update(triggers)
		.set({ nextRunAt: nextScheduledRun(schedule, now) })
		.where(eq(triggers.id, trigger.id))
		.run();
	if (admitted.status !== "start") return admitted;
	return { ...admitted, text: triggerMessage(trigger.prompt, body) };
}

/** What `admitDelivery` decided, before the message is made. */
export type Admission =
	| { status: "start"; conversationId: string }
	| { status: "duplicate"; runId: string | null }
	| { status: "starting"; retryAfter: number }
	| { status: "skipped" }
	| { status: "limited"; retryAfter: number; message: string }
	| { status: "refused"; message: string };

/**
 * Decides what a signed delivery does, and records it under its `webhook-id`. A retry of one that
 * started a run, or was skipped, starts nothing; one whose run is starting is asked to come back,
 * since that run may still fail to begin; one that was over a limit or could not begin is tried
 * again. Within the limits, it opens the delivery's conversation, whose run the runtime begins
 * next.
 */
export function admitDelivery(
	db: Db,
	trigger: NonNullable<ReturnType<typeof triggerRow>>,
	delivery: { id: string; body: string },
	now: number,
): Admission {
	db.delete(triggerDeliveries)
		.where(
			and(
				eq(triggerDeliveries.triggerId, trigger.id),
				lt(triggerDeliveries.receivedAt, now - DELIVERY_RETENTION),
			),
		)
		.run();
	const earlier = db
		.select()
		.from(triggerDeliveries)
		.where(and(eq(triggerDeliveries.triggerId, trigger.id), eq(triggerDeliveries.id, delivery.id)))
		.get();
	if (earlier) {
		if (earlier.status === "started" || earlier.status === "skipped") {
			return { status: "duplicate", runId: earlier.runId };
		}
		if (earlier.status === "accepted" && earlier.receivedAt > now - ACCEPT_TIMEOUT) {
			return {
				status: "starting",
				retryAfter: secondsUntil(earlier.receivedAt + ACCEPT_TIMEOUT, now),
			};
		}
		// The conversation opened for it had no run, so the retry opens another in its place.
		if (earlier.conversationId !== null && earlier.runId === null) {
			db.delete(conversations).where(eq(conversations.id, earlier.conversationId)).run();
		}
	}
	const event = eventType(delivery.body);
	const record = (
		status: TriggerDelivery["status"],
		values: { error?: string | null; conversationId?: string | null } = {},
	) => {
		const row = {
			status,
			event,
			conversationId: values.conversationId ?? null,
			runId: null,
			error: values.error ?? null,
			receivedAt: now,
		};
		db.insert(triggerDeliveries)
			.values({ triggerId: trigger.id, id: delivery.id, ...row })
			.onConflictDoUpdate({
				target: [triggerDeliveries.triggerId, triggerDeliveries.id],
				set: row,
			})
			.run();
	};

	if (!trigger.active) {
		record("skipped", { error: "The trigger was paused" });
		return { status: "skipped" };
	}
	if (trigger.events && !(event && trigger.events.includes(event))) {
		const wanted = trigger.events.join(", ");
		record("skipped", {
			error: event
				? `It starts runs on ${wanted} only, not ${event}`
				: `It starts runs on ${wanted} only, and the event has no type`,
		});
		return { status: "skipped" };
	}
	const unlabeled = trigger.label === null ? null : labelSkip(trigger.label, delivery.body);
	if (unlabeled) {
		record("skipped", { error: unlabeled });
		return { status: "skipped" };
	}
	const limited = limitOf(db, trigger, now);
	if (limited) {
		record("limited", { error: limited.message });
		return { status: "limited", ...limited };
	}
	const target: TriggerTarget = trigger.teamId
		? { kind: "team", teamId: trigger.teamId }
		: { kind: "agent", agentId: trigger.agentId ?? "" };
	const refusal = targetRefusal(db, target);
	const answers =
		target.kind === "team" ? teamLead(db, target.teamId)?.leadAgentId : target.agentId;
	if (refusal || !answers) {
		const message = refusal ?? "Nobody can answer this trigger";
		record("failed", { error: message });
		return { status: "refused", message };
	}
	const conversationId = crypto.randomUUID();
	db.insert(conversations)
		.values({
			id: conversationId,
			agentId: answers,
			startedBy: triggerStarter(trigger.id),
			teamId: target.kind === "team" ? target.teamId : null,
			rootId: null,
			triggerId: trigger.id,
			title: event && event !== SCHEDULE_EVENT ? `${trigger.name}: ${event}` : trigger.name,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	record("accepted", { conversationId });
	return { status: "start", conversationId };
}

/** The delivery a trigger's conversation was opened for. */
export function deliveryOf(db: Db, conversationId: string) {
	return (
		db
			.select()
			.from(triggerDeliveries)
			.where(eq(triggerDeliveries.conversationId, conversationId))
			.get() ?? null
	);
}

/** Notes that a delivery's run began, or why it could not. */
export function settleDelivery(
	db: Db,
	conversationId: string,
	outcome: { runId: string } | { error: string },
): void {
	db.update(triggerDeliveries)
		.set(
			"runId" in outcome
				? { status: "started", runId: outcome.runId, error: null }
				: { status: "failed", error: outcome.error },
		)
		.where(
			and(
				eq(triggerDeliveries.conversationId, conversationId),
				eq(triggerDeliveries.status, "accepted"),
			),
		)
		.run();
}

/**
 * Whether one more run would take the trigger over its runs per minute or per day, and if so when
 * there is room again. Runs that began count, and those about to.
 */
function limitOf(
	db: Db,
	trigger: { id: string; perDay: number },
	now: number,
): { retryAfter: number; message: string } | null {
	const counted = (since: number) =>
		db
			.select({ n: count(), oldest: min(triggerDeliveries.receivedAt) })
			.from(triggerDeliveries)
			.where(
				and(
					eq(triggerDeliveries.triggerId, trigger.id),
					inArray(triggerDeliveries.status, ["accepted", "started"]),
					gte(triggerDeliveries.receivedAt, since),
				),
			)
			.get();
	const minute = counted(now - MINUTE);
	if ((minute?.n ?? 0) >= TRIGGER_LIMITS.perMinute) {
		return {
			retryAfter: secondsUntil((minute?.oldest ?? now) + MINUTE, now),
			message: `The trigger started ${TRIGGER_LIMITS.perMinute} runs in the last minute`,
		};
	}
	const day = counted(now - DAY);
	if ((day?.n ?? 0) >= trigger.perDay) {
		return {
			retryAfter: secondsUntil((day?.oldest ?? now) + DAY, now),
			message: `The trigger started its ${trigger.perDay} runs for the day`,
		};
	}
	return null;
}

function secondsUntil(at: number, now: number): number {
	return Math.max(1, Math.ceil((at - now) / 1000));
}

function runnable(db: Db, agentId: string): boolean {
	return (
		db
			.select({ id: agents.id })
			.from(agents)
			.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
			.where(and(eq(agents.id, agentId), isNull(agents.removedAt)))
			.get() !== undefined
	);
}

function latestDeliveries(db: Db, triggerId: string): TriggerDelivery[] {
	return db
		.select({
			id: triggerDeliveries.id,
			triggerId: triggerDeliveries.triggerId,
			status: triggerDeliveries.status,
			event: triggerDeliveries.event,
			runId: triggerDeliveries.runId,
			error: triggerDeliveries.error,
			receivedAt: triggerDeliveries.receivedAt,
		})
		.from(triggerDeliveries)
		.where(eq(triggerDeliveries.triggerId, triggerId))
		.orderBy(desc(triggerDeliveries.receivedAt))
		.limit(TRIGGER_LIMITS.shownDeliveries)
		.all();
}

function selectTriggers(db: Db) {
	return db
		.select({
			trigger: triggers,
			agentName: agents.name,
			agentRemovedAt: agents.removedAt,
			teamName: teams.name,
		})
		.from(triggers)
		.leftJoin(agents, eq(agents.id, triggers.agentId))
		.leftJoin(teams, eq(teams.id, triggers.teamId))
		.$dynamic();
}

function toTrigger({
	trigger,
	agentName,
	agentRemovedAt,
	teamName,
}: {
	trigger: typeof triggers.$inferSelect;
	agentName: string | null;
	agentRemovedAt: number | null;
	teamName: string | null;
}): Trigger {
	const { agentId, teamId, sealed: _, createdBy: __, ...rest } = trigger;
	const target: TriggerTarget = teamId
		? { kind: "team", teamId }
		: { kind: "agent", agentId: agentId ?? "" };
	const targetName = teamId ? teamName : agentRemovedAt === null ? agentName : null;
	return { ...rest, target, targetName };
}

/** Standard or URL-safe base64, padded or not; null when it is not base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	const standard = text.trim().replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
	if (standard.length === 0 || !/^[A-Za-z0-9+/]*$/.test(standard)) return null;
	try {
		const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}
