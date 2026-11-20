import { env } from "cloudflare:workers";
import { objectsIn } from "@gateweave/agents-registry";
import { conversationName, destroyConversationObject } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { deploymentJurisdiction } from "./jurisdiction";

/** How many conversations are deleted at once, so a big workspace does not open hundreds of calls. */
const AT_ONCE = 10;

/**
 * How often a refused forget of an old copy is tried before the deletion leaves it for the daily
 * run. A copy a move is still filling refuses for the length of that move, which no retry here
 * waits out; the daily run's seven-day forget picks it up after (`move.ts`).
 */
const FORGET_TRIES = 3;
const FORGET_RETRY_MS = 1_000;

/**
 * Deletes what a deleted workspace held outside D1: each conversation, with its messages, traces
 * and sandbox, then the registry, with its sealed keys and secrets. The registry goes last, since
 * it is what knows the conversations. A conversation that fails is logged and the rest go on;
 * nothing of the workspace is reachable either way, since only members get through and none are
 * left.
 *
 * Its objects can be in more than one place ("Where a workspace lives" in docs/architecture.md):
 * where it is, the sealed ones it moved from, and the half-filled copy of a move that gave up. Each
 * place is emptied, then D1 forgets where they were — unless an old copy refused to be forgotten:
 * its registry and its row stay, so the daily run tries again instead of the copy being dropped
 * (AGT-156).
 */
export async function deleteWorkspaceData(db: Database, workspaceId: string): Promise<void> {
	const location = await db
		.select()
		.from(schema.workspaceLocation)
		.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
		.get();
	const places = new Set([location?.jurisdiction ?? ""]);
	if (location) {
		if (location.movedFrom !== null) places.add(location.movedFrom);
		const target = deploymentJurisdiction();
		if (target) places.add(target);
	}
	let keptForRetry = false;
	for (const place of places) {
		keptForRetry =
			(await deleteObjectsIn(
				place,
				workspaceId,
				place === location?.movedFrom && place !== location.jurisdiction,
			)) || keptForRetry;
	}
	if (location && !keptForRetry) {
		await db
			.delete(schema.workspaceLocation)
			.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
			.run();
	}
}

/**
 * Empties one place of a deleted workspace, and destroys its registry. Answers whether an old
 * copy was left for the daily run to forget: then its registry stays, since it is what lists the
 * conversations still waiting.
 */
async function deleteObjectsIn(
	place: string,
	workspaceId: string,
	oldCopy: boolean,
): Promise<boolean> {
	const registry = objectsIn(env.REGISTRY, place).getByName(workspaceId);
	const ids = await registry.conversationIds();
	let refused = false;
	for (let start = 0; start < ids.length; start += AT_ONCE) {
		await Promise.all(
			ids.slice(start, start + AT_ONCE).map(async (conversationId) => {
				try {
					const name = conversationName(workspaceId, conversationId);
					const conversations = objectsIn(env.CONVERSATIONS, place);
					if (oldCopy) await forgetWithRetries(conversations.getByName(name));
					else await destroyConversationObject(await getAgentByName(conversations, name));
				} catch (error) {
					refused = true;
					console.error("A deleted workspace's conversation was not deleted", {
						workspaceId,
						conversationId,
						place,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
	}
	if (oldCopy && refused) return true;
	await registry.destroy();
	return false;
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
