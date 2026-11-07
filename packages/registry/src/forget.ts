/**
 * What a workspace's registry does when someone's account is deleted. It keeps ids and no names, so
 * nothing needs rewriting: what they set up stays as the team's, and their runs stay for usage, with
 * words in neither. Their conversations have to go, since they hold what the person wrote and nobody
 * else can open them.
 *
 * The rows go in one write, in case the objects cannot be reached, and the alarm destroys the objects.
 * Each alarm has a subrequest budget of its own, so someone with hundreds of conversations is done in
 * minutes on any plan, which a Worker's request or daily cron could not promise.
 */
import { asc, eq, lte, min, sql } from "drizzle-orm";
import { conversations, conversationsToDestroy, runs } from "./db/schema";
import type { Db } from "./state";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/**
 * Takes the rows of the conversations the person started, which include those their team's nested
 * turns ran in, since those name whoever started the conversation they go with, and clears their runs'
 * link to them, as deleting a conversation does. A trigger's conversation names the trigger, so it
 * stays. Doing it again finds nothing.
 */
export function queueConversationsOf(db: Db, person: string, now: number): void {
	db.insert(conversationsToDestroy)
		.select(sql`SELECT id, ${now}, 0 FROM conversations WHERE started_by = ${person}`)
		.onConflictDoNothing()
		.run();
	const queued = db.select({ id: conversationsToDestroy.id }).from(conversationsToDestroy);
	db.update(runs)
		.set({ conversationId: null })
		.where(sql`${runs.conversationId} IN ${queued}`)
		.run();
	db.delete(conversations).where(sql`${conversations.id} IN ${queued}`).run();
}

/** The ones the alarm may try now, those waiting longest first. */
export function dueConversations(db: Db, now: number, limit: number): string[] {
	return db
		.select({ id: conversationsToDestroy.id })
		.from(conversationsToDestroy)
		.where(lte(conversationsToDestroy.nextAttemptAt, now))
		.orderBy(asc(conversationsToDestroy.nextAttemptAt))
		.limit(limit)
		.all()
		.map((row) => row.id);
}

export function queuedConversations(db: Db): string[] {
	return db
		.select({ id: conversationsToDestroy.id })
		.from(conversationsToDestroy)
		.all()
		.map((row) => row.id);
}

export function noteDestroyed(db: Db, id: string): void {
	db.delete(conversationsToDestroy).where(eq(conversationsToDestroy.id, id)).run();
}

/**
 * It is tried again for as long as it takes, since it holds someone's words: a minute later at first,
 * then twice as long each time, up to a day.
 */
export function noteDestroyFailed(db: Db, id: string, now: number): void {
	const row = db
		.select({ failures: conversationsToDestroy.failures })
		.from(conversationsToDestroy)
		.where(eq(conversationsToDestroy.id, id))
		.get();
	if (!row) return;
	db.update(conversationsToDestroy)
		.set({
			failures: row.failures + 1,
			nextAttemptAt: now + Math.min(2 ** row.failures * MINUTE, DAY),
		})
		.where(eq(conversationsToDestroy.id, id))
		.run();
}

export function nextDestroyAt(db: Db): number | null {
	const row = db
		.select({ at: min(conversationsToDestroy.nextAttemptAt) })
		.from(conversationsToDestroy)
		.get();
	return row?.at ?? null;
}
