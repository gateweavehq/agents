import type { env } from "cloudflare:workers";
import { type AgentDefinitionInput, agentDefinitionInput } from "@gateweave/agents-model";

/** Older fixtures describe creation inputs; expand their defaults for a full edit. */
export async function saveAgent(
	stub: ReturnType<typeof env.REGISTRY.getByName>,
	id: string,
	input: AgentDefinitionInput,
) {
	const current = await stub.getAgent(id);
	return stub.updateAgent(id, agentDefinitionInput.parse(input), current?.agent.updatedAt ?? 0);
}
