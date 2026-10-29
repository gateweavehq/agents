import { env } from "cloudflare:workers";

/**
 * The workspace's registry. It has no route of its own and trusts its caller, so reach it only
 * after `findMembership` has confirmed the caller belongs to the workspace. The one exception is a
 * trigger's delivery (`./triggers.ts`), which no member sends: the registry checks its signature.
 */
export function registryFor(workspaceId: string) {
	return env.REGISTRY.getByName(workspaceId);
}
