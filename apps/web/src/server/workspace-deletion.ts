import { env } from "cloudflare:workers";
import { conversationName, destroyConversationObject } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { registryFor } from "./registry";

/** How many conversations are deleted at once, so a big workspace does not open hundreds of calls. */
const AT_ONCE = 10;

/**
 * Deletes what a deleted workspace held outside D1: each conversation, with its messages, traces
 * and sandbox, then the registry, with its sealed keys and secrets. The registry goes last, since
 * it is what knows the conversations. A conversation that fails is logged and the rest go on;
 * nothing of the workspace is reachable either way, since only members get through and none are
 * left.
 */
export async function deleteWorkspaceData(workspaceId: string): Promise<void> {
	const registry = registryFor(workspaceId);
	const ids = await registry.conversationIds();
	for (let start = 0; start < ids.length; start += AT_ONCE) {
		await Promise.all(
			ids.slice(start, start + AT_ONCE).map(async (conversationId) => {
				try {
					const conversation = await getAgentByName(
						env.CONVERSATIONS,
						conversationName(workspaceId, conversationId),
					);
					await destroyConversationObject(conversation);
				} catch (error) {
					console.error("A deleted workspace's conversation was not deleted", {
						workspaceId,
						conversationId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
	}
	await registry.destroy();
}
