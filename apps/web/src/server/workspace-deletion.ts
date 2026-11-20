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
 * Deletes what a deleted workspace held outside D1: each conversation, with its messages, traces
 * and sandbox, then the registry, with its sealed keys and secrets. The registry goes last, since
 * it is what knows the conversations. A conversation that fails is logged and the rest go on;
 * nothing of the workspace is reachable either way, since only members get through and none are
 * left.
 *
 * Its objects can be in more than one place ("Where a workspace lives" in docs/architecture.md):
 * where it is, the sealed ones it moved from, and the half-filled copy of a move that gave up. Each
 * place is emptied, then D1 forgets where they were.
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
	for (const place of places) {
		await deleteObjectsIn(
			place,
			workspaceId,
			place === location?.movedFrom && place !== location.jurisdiction,
		);
	}
	if (location) {
		await db
			.delete(schema.workspaceLocation)
			.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
			.run();
	}
}

async function deleteObjectsIn(
	place: string,
	workspaceId: string,
	oldCopy: boolean,
): Promise<void> {
	const registry = objectsIn(env.REGISTRY, place).getByName(workspaceId);
	const ids = await registry.conversationIds();
	for (let start = 0; start < ids.length; start += AT_ONCE) {
		await Promise.all(
			ids.slice(start, start + AT_ONCE).map(async (conversationId) => {
				try {
					const name = conversationName(workspaceId, conversationId);
					const conversations = objectsIn(env.CONVERSATIONS, place);
					if (oldCopy) await conversations.getByName(name).moveForget();
					else await destroyConversationObject(await getAgentByName(conversations, name));
				} catch (error) {
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
	await registry.destroy();
}
