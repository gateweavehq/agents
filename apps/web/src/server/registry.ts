import { env } from "cloudflare:workers";
import { objectsIn } from "@gateweave/agents-registry";
import { conversationName } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import type { Database } from "./db";
import { findWorkspaceRef, type WorkspaceRef } from "./workspaces";

/**
 * The workspace's registry, where its objects are. It has no route of its own and trusts its
 * caller, so reach it only after `findMembership` has confirmed the caller belongs to the
 * workspace. The one exception is a trigger's delivery (`./triggers.ts`), which no member sends:
 * the registry checks its signature.
 */
export function registryFor({ workspaceId, jurisdiction }: WorkspaceRef) {
	return objectsIn(env.REGISTRY, jurisdiction).getByName(workspaceId);
}

/** As `registryFor`, for a workspace known by its id alone. */
export async function findRegistry(db: Database, workspaceId: string) {
	return registryFor(await findWorkspaceRef(db, workspaceId));
}

/** One of the workspace's conversations, where its objects are, under the same trust. */
export function conversationFor(
	{ workspaceId, jurisdiction }: WorkspaceRef,
	conversationId: string,
) {
	return getAgentByName(
		objectsIn(env.CONVERSATIONS, jurisdiction),
		conversationName(workspaceId, conversationId),
	);
}
