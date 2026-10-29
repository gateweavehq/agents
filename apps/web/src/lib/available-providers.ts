import type { ModelProvider, ProviderKey } from "@gateweave/agents-model";

/**
 * The providers an agent can use here: those the workspace has a key for, and Workers AI when the
 * server offers it (it needs no key of the workspace's).
 */
export function availableProviders(
	found: { keys: ProviderKey[]; workersAi: boolean } | null,
): ModelProvider[] {
	if (!found) return [];
	const providers: ModelProvider[] = found.keys.map((key) => key.provider);
	if (found.workersAi) providers.push("workers-ai");
	return providers;
}
