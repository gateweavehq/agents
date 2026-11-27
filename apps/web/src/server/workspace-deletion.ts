import { env } from "cloudflare:workers";
import { objectsIn } from "@gateweave/agents-registry";
import { conversationName, destroyConversationObject } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { and, asc, eq, exists, isNull, notExists, sql } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { deploymentJurisdiction } from "./jurisdiction";

// "Deleting a workspace" in docs/architecture.md.

/** How many conversations are deleted at once, so a big workspace does not open hundreds of calls. */
const AT_ONCE = 10;

/**
 * How many deletions one daily run finishes. Each takes a call or two for every conversation and a
 * few more for its registries and rows, of the thousand calls to Cloudflare's services a Worker on
 * the Free plan may make (ten thousand on the Paid plan), which the moves after it share.
 */
const DELETIONS_PER_RUN = 2;

/**
 * How many conversations one daily run tries, across the deletions it finishes. Each can call
 * its conversation's sandbox too. Leave room within the Free plan's thousand calls for recording
 * progress, the moves and the rest of the daily run.
 */
const CONVERSATIONS_PER_RUN = 200;

/**
 * How often a refused forget of an old copy is tried before the deletion leaves it for the daily
 * run. A copy a move is still filling refuses for the length of that move, which no retry here
 * waits out; the daily run tries the deletion again, and its seven-day forget (`move.ts`) can
 * take the copy too.
 */
const FORGET_TRIES = 3;
const FORGET_RETRY_MS = 1_000;

/**
 * Deletes what a deleted workspace held outside D1: each conversation, with its messages, traces
 * and sandbox, then the registry, with its sealed keys and secrets. The registry goes last, since
 * it is what knows the conversations. A conversation that fails, or an old copy's that refuses to
 * be forgotten, is logged and the rest go on, but its registry stays, and this throws once every
 * place has been tried: a retry skips the conversations the registry recorded, and deleting one
 * twice is harmless. A registry failure also leaves the other places to be tried before this throws.
 *
 * Its objects can be in more than one place ("Where a workspace lives" in docs/architecture.md):
 * where it is, the sealed ones it moved from, and the half-filled copy of a move that gave up. Each
 * place is emptied, then D1 forgets where they were and the workspace's deletion note, in one
 * batch. The location row goes only as it was read, so a move that recorded a new place meanwhile
 * keeps it, and with it the note, for the next try.
 */
export async function deleteWorkspaceData(
	db: Database,
	workspaceId: string,
	budget?: { conversations: number },
): Promise<void> {
	const location = await db
		.select()
		.from(schema.workspaceLocation)
		.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
		.get();
	const places = new Set([location?.jurisdiction ?? ""]);
	if (location?.movedFrom != null) places.add(location.movedFrom);
	// Even with no row: a first move that gave up leaves its half-filled copy there unrecorded.
	const target = deploymentJurisdiction();
	if (target) places.add(target);
	let left = 0;
	const failures: unknown[] = [];
	for (const place of places) {
		try {
			left += await deleteObjectsIn(
				place,
				workspaceId,
				place === location?.movedFrom && place !== location.jurisdiction,
				budget,
			);
		} catch (error) {
			failures.push(error);
			console.error("A deleted workspace's registry cleanup failed", {
				workspaceId,
				jurisdiction: place || "default",
				error: messageOf(error),
			});
		}
	}
	if (failures.length > 0) throw failures[0];
	if (left > 0) {
		throw new Error(`${left} of the workspace's conversations are left for the next try`);
	}
	const { workspaceLocation: row, workspaceDeletion: note } = schema;
	const forgetNote = db
		.delete(note)
		.where(
			and(
				eq(note.workspaceId, workspaceId),
				notExists(
					db
						.select({ workspaceId: row.workspaceId })
						.from(row)
						.where(eq(row.workspaceId, workspaceId)),
				),
			),
		);
	if (!location) {
		await forgetNote.run();
		return;
	}
	await db.batch([
		db
			.delete(row)
			.where(
				and(
					eq(row.workspaceId, workspaceId),
					eq(row.jurisdiction, location.jurisdiction),
					location.movedFrom === null
						? isNull(row.movedFrom)
						: eq(row.movedFrom, location.movedFrom),
				),
			),
		forgetNote,
	]);
}

/**
 * Deletes a workspace the app deletes on its own, as the demo does: its row, with its members by
 * cascade and its note in the same batch, then what its objects hold. Only the batch can fail:
 * a failure after it is logged, and the note stays for the daily run.
 */
export async function deleteWorkspaceWithData(db: Database, workspaceId: string): Promise<void> {
	await db.batch([
		db
			.insert(schema.workspaceDeletion)
			.values({ workspaceId, deletedAt: Date.now() })
			.onConflictDoNothing(),
		db.delete(schema.organization).where(eq(schema.organization.id, workspaceId)),
	]);
	try {
		await finishWorkspaceDeletion(db, workspaceId);
	} catch (error) {
		console.error(`deletion: workspace ${workspaceId} isn't done yet: ${messageOf(error)}`);
	}
}

/**
 * Finishes a deletion its note says is due: right after the request that deleted the workspace,
 * and from the daily run for any that failed. A note for a workspace that is still there is wrong,
 * whatever wrote it, so it goes and nothing is deleted.
 */
export async function finishWorkspaceDeletion(
	db: Database,
	workspaceId: string,
	budget?: { conversations: number },
): Promise<void> {
	const { organization, workspaceDeletion: note } = schema;
	const live = await db
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.id, workspaceId))
		.get();
	if (live) {
		// Only while the row is still there: were the workspace deleted since, the note is its own.
		await db
			.delete(note)
			.where(
				and(
					eq(note.workspaceId, workspaceId),
					exists(
						db
							.select({ id: organization.id })
							.from(organization)
							.where(eq(organization.id, workspaceId)),
					),
				),
			)
			.run();
		throw new Error("the workspace is still there, so its note went and nothing was deleted");
	}
	try {
		await deleteWorkspaceData(db, workspaceId, budget);
	} catch (error) {
		// The failure that matters is the one above, even when this can't be noted either.
		await db
			.update(note)
			.set({ lastTriedAt: Date.now() })
			.where(eq(note.workspaceId, workspaceId))
			.run()
			.catch(() => {});
		throw error;
	}
}

/**
 * From the daily run: deletions a request couldn't finish, the longest waiting first and those
 * that keep failing last. Location rows whose workspace is gone get a note first, which covers
 * deletions from before the notes, and a copy a move recorded after its workspace's deletion read
 * where it was. Only ids reach the log, and a failure never stops the rest of the run.
 */
export async function retryWorkspaceDeletions(db: Database): Promise<void> {
	try {
		await db
			.insert(schema.workspaceDeletion)
			.select(
				sql`SELECT workspace_id, ${Date.now()}, NULL FROM workspace_location
					WHERE NOT EXISTS (SELECT 1 FROM organization WHERE organization.id = workspace_location.workspace_id)`,
			)
			.onConflictDoNothing()
			.run();
		const due = await db
			.select({ workspaceId: schema.workspaceDeletion.workspaceId })
			.from(schema.workspaceDeletion)
			.orderBy(asc(schema.workspaceDeletion.lastTriedAt), asc(schema.workspaceDeletion.deletedAt))
			.limit(DELETIONS_PER_RUN)
			.all();
		const budget = { conversations: CONVERSATIONS_PER_RUN };
		for (const { workspaceId } of due) {
			if (budget.conversations <= 0) break;
			try {
				await finishWorkspaceDeletion(db, workspaceId, budget);
				console.log(`deletion: workspace ${workspaceId} is deleted`);
			} catch (error) {
				console.error(`deletion: workspace ${workspaceId} isn't done: ${messageOf(error)}`);
			}
		}
	} catch (error) {
		console.error(`deletion: the deleted workspaces weren't looked at: ${messageOf(error)}`);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Empties one place of a deleted workspace, and destroys its registry. Answers how many of its
 * conversations were left: then its registry stays, since it is what lists them for the next try.
 */
async function deleteObjectsIn(
	place: string,
	workspaceId: string,
	oldCopy: boolean,
	budget?: { conversations: number },
): Promise<number> {
	const registry = objectsIn(env.REGISTRY, place).getByName(workspaceId);
	const ids = await registry.conversationsToDestroy();
	const taking: string[] = [];
	for (const id of ids) {
		if (budget && budget.conversations <= 0) break;
		if (budget) budget.conversations--;
		taking.push(id);
	}
	let left = ids.length - taking.length;
	for (let start = 0; start < taking.length; start += AT_ONCE) {
		const results = await Promise.all(
			taking.slice(start, start + AT_ONCE).map(async (conversationId) => {
				try {
					const name = conversationName(workspaceId, conversationId);
					const conversations = objectsIn(env.CONVERSATIONS, place);
					if (oldCopy) await forgetWithRetries(conversations.getByName(name));
					else await destroyConversationObject(await getAgentByName(conversations, name));
					return conversationId;
				} catch (error) {
					left++;
					console.error("A deleted workspace's conversation was not deleted", {
						workspaceId,
						conversationId,
						place,
						error: error instanceof Error ? error.message : String(error),
					});
					return null;
				}
			}),
		);
		const destroyed = results.filter((id) => id !== null);
		if (destroyed.length > 0) await registry.noteConversationsDestroyed(destroyed);
	}
	if (left > 0) return left;
	await registry.destroy();
	return 0;
}

/** Forgets one sealed conversation of an old copy, retrying a refusal before giving up on it. */
async function forgetWithRetries(conversation: { moveForget(): Promise<unknown> }): Promise<void> {
	for (let tryNumber = 1; ; tryNumber++) {
		try {
			await conversation.moveForget();
			return;
		} catch (error) {
			if (tryNumber === FORGET_TRIES) throw error;
			await new Promise((resolve) => setTimeout(resolve, FORGET_RETRY_MS));
		}
	}
}
