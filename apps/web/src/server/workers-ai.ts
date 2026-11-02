import { env } from "cloudflare:workers";
import {
	type ProviderModel,
	type WorkersAiOffer,
	workersAiOffered,
	workersAiOfferTo,
} from "@gateweave/agents-model";
import { listWorkersAiModels } from "@gateweave/agents-runtime";

/**
 * Whether this deployment offers Workers AI. Only the answer leaves the server: the token that
 * pays for it is the deployment's, and no page, server function or registry call returns it.
 */
export function offersWorkersAi(workspaceId?: string): boolean {
	return workspaceId === undefined
		? workersAiOffered(env)
		: workersAiOfferTo(env, workspaceId) === "offered";
}

/** Whether a workspace may use Workers AI here: as every workspace may, by invitation, or not. */
export function workersAiOffer(workspaceId: string): WorkersAiOffer {
	return workersAiOfferTo(env, workspaceId);
}

/** The models Workers AI offers this deployment, listed with its own token. */
export async function workersAiModels(): Promise<ProviderModel[]> {
	const listed = await listWorkersAiModels(env);
	if (!listed.ok) throw new Error(listed.message);
	return listed.models;
}
