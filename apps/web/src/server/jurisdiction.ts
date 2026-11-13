import { env } from "cloudflare:workers";
import { configuredJurisdiction } from "@gateweave/agents-registry";

// "Where a workspace lives" in docs/architecture.md.

/**
 * The jurisdiction this deployment keeps workspaces in, from `DURABLE_OBJECT_JURISDICTION`, or
 * null for none. A value Cloudflare doesn't know throws: the operator asked for their data to stay
 * somewhere.
 */
export function deploymentJurisdiction(): DurableObjectJurisdiction | null {
	return configuredJurisdiction(env.DURABLE_OBJECT_JURISDICTION);
}
