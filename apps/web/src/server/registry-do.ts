import type { TriggerTurnOutcome } from "@gateweave/agents-model";
import { RegistryDO as Registry } from "@gateweave/agents-registry";
import { conversationName } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";

/**
 * The workspace's registry as this Worker runs it: the registry package's, which begins a
 * scheduled trigger's run in the runtime's conversation as the trigger gateway does for a webhook
 * (`./triggers.ts`). The registry package cannot reach the runtime on its own.
 */
export class RegistryDO extends Registry {
	protected override async startTriggerTurn(
		conversationId: string,
		text: string,
	): Promise<TriggerTurnOutcome> {
		// Each registry is named for its workspace (`registryFor`).
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) return { runId: null, error: "This registry does not know its workspace" };
		const conversation = await getAgentByName(
			this.env.CONVERSATIONS,
			conversationName(workspaceId, conversationId),
		);
		return conversation.triggerTurn(text);
	}
}
