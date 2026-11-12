import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
	AUDIT_PAGE_SIZE,
	type AuditAction,
	type AuditDetail,
	type AuditEvent,
	type AuditPage,
	type AuditPerson,
	type AuditTarget,
} from "../lib/audit-events";
import { type Database, schema } from "./db";

/**
 * Each workspace's audit log (`lib/audit-events.ts` says what is in it). The registry is never told
 * who asks, so the Worker records a change once the registry or Better Auth has made it, and a
 * change that failed leaves nothing. A row that cannot be written is logged and lost.
 */

/** Long enough to look back over a year's changes; no longer, as it names people. */
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** D1 runs one query at a time, so pruning goes in batches. */
const PRUNE_BATCH = 1000;

export interface AuditRecord {
	action: AuditAction;
	target: AuditTarget;
	detail?: AuditDetail;
}

export async function recordAudit(
	db: Database,
	workspaceId: string,
	actorId: string | null,
	record: AuditRecord,
	now = Date.now(),
): Promise<void> {
	await db
		.insert(schema.auditEvent)
		.values({
			organizationId: workspaceId,
			at: now,
			actorId,
			action: record.action,
			targetType: record.target.type,
			targetId: record.target.id,
			targetLabel: record.target.label,
			detail: record.detail ?? {},
		})
		.run();
}

interface Member {
	user: { id: string };
	membership: { workspaceId: string };
}

/**
 * What a server function records its change with, once the change is made. It never throws: the
 * change stands either way, and the person should hear that it did.
 */
export function auditFor(member: Member): (record: AuditRecord) => Promise<void> {
	return async (record) => {
		try {
			const { db } = await import("./auth");
			await recordAudit(db, member.membership.workspaceId, member.user.id, record);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(`audit: could not record ${record.action}: ${reason}`);
		}
	};
}

/** A page of the workspace's log, the newest first, with everyone its events name. */
export async function readAuditPage(
	db: Database,
	workspaceId: string,
	before?: number,
): Promise<AuditPage> {
	const table = schema.auditEvent;
	const rows = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, workspaceId),
				before === undefined ? undefined : lt(table.id, before),
			),
		)
		.orderBy(desc(table.id))
		.limit(AUDIT_PAGE_SIZE + 1)
		.all();
	const page = rows.slice(0, AUDIT_PAGE_SIZE);
	const events = page.map(
		(row): AuditEvent => ({
			id: row.id,
			at: row.at,
			actorId: row.actorId,
			action: row.action,
			target: { type: row.targetType, id: row.targetId, label: row.targetLabel },
			detail: row.detail,
		}),
	);
	const last = page.at(-1);
	return {
		events,
		people: await peopleIn(db, events),
		next: rows.length > AUDIT_PAGE_SIZE && last ? last.id : null,
	};
}

/**
 * Named as the deployment knows them now, so someone who deleted their account is not named.
 * Matched through `json_each`, since D1 binds at most 100 parameters to a query.
 */
async function peopleIn(db: Database, events: AuditEvent[]): Promise<Record<string, AuditPerson>> {
	const ids = new Set<string>();
	for (const event of events) {
		if (event.actorId) ids.add(event.actorId);
		if (event.target.type === "member" && event.target.id) ids.add(event.target.id);
	}
	const people: Record<string, AuditPerson> = {};
	if (ids.size === 0) return people;
	const rows = await db
		.select({ id: schema.user.id, name: schema.user.name, image: schema.user.image })
		.from(schema.user)
		.where(sql`${schema.user.id} in (select value from json_each(${JSON.stringify([...ids])}))`)
		.all();
	for (const row of rows) people[row.id] = { name: row.name, image: row.image ?? null };
	return people;
}

/** Drops the events older than a year. The daily cron runs it with the rest of `pruneExpired`. */
export async function pruneAudit(db: Database, now = Date.now()): Promise<void> {
	const table = schema.auditEvent;
	for (;;) {
		const old = db
			.select({ id: table.id })
			.from(table)
			.where(lt(table.at, now - AUDIT_RETENTION_MS))
			.limit(PRUNE_BATCH);
		const { meta } = await db.delete(table).where(inArray(table.id, old)).run();
		if (meta.changes < PRUNE_BATCH) return;
	}
}

/**
 * Clears an address someone who deleted their account was invited at, in every workspace: a
 * statement for the batch that deletes the account. Invitations are logged by address, as the
 * person may never have joined; addresses are stored in lower case.
 */
export function forgetInAudit(db: Database, email: string) {
	return db
		.update(schema.auditEvent)
		.set({ targetLabel: null })
		.where(
			and(
				eq(schema.auditEvent.targetType, "invitation"),
				eq(schema.auditEvent.targetLabel, email.toLowerCase()),
			),
		);
}
