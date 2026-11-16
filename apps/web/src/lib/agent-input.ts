import type {
	Agent,
	AgentDefinition,
	agentDefinitionInput,
	PinnedAsset,
} from "@gateweave/agents-model";
import type { z } from "zod";

/**
 * An agent's definition with every field given, as the schema leaves it once its defaults are
 * filled. A save that sends less has the missing fields set to their defaults, which is how moving
 * a pin once turned an agent's engine and memory back (AGT-135).
 */
export type WholeAgentInput = z.output<typeof agentDefinitionInput>;

/**
 * The update that leaves an agent as it is, with every pin where it is. Its type makes a field
 * added to the schema an error here until it is carried, and `agent-input.test.ts` checks the
 * same of the object it returns.
 */
export function inputOf(agent: Agent, definition: AgentDefinition): WholeAgentInput {
	return {
		name: agent.name,
		description: agent.description,
		provider: definition.provider,
		model: definition.model,
		instructions: keep(definition.instructions),
		environment: keep(definition.environment),
		mcpServers: definition.mcpServers.map((server) => ({
			assetId: server.asset.id,
			version: server.version,
			tools: server.tools,
		})),
		sandbox: definition.sandbox,
		repositoryId: definition.repository?.id ?? null,
		engine: definition.engine,
		memory: definition.memory,
	};
}

/** What an agent update sends for a pin it keeps. */
function keep(pin: PinnedAsset | null): { assetId: string; version: number } | null {
	return pin && { assetId: pin.asset.id, version: pin.version };
}
