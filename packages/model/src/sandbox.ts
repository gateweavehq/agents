/**
 * Sandboxes: a Linux machine for each conversation with an agent run by Gateweave, where its turns
 * run commands and read and write files. A deployment offers them when it has the container
 * binding; these are the pure parts the registry, the runtime and the app share.
 */

/** What a deployment has when it offers sandboxes: the binding of their Durable Objects. */
export interface SandboxSettings {
	SANDBOX?: unknown;
}

/** Minutes without a request after which a sandbox stops, and its files go with it. */
export const SANDBOX_IDLE_MINUTES = 15;

/**
 * Most sandboxes one workspace's conversations have at once. A sandbox counts from its first turn
 * until `SANDBOX_IDLE_MINUTES` after its last; the deployment's account pays for each.
 */
export const MAX_WORKSPACE_SANDBOXES = 3;

/** Why an agent with a sandbox cannot answer on a server that runs none. */
export const SANDBOX_NOT_OFFERED = "This server does not run sandboxes";

/** Whether the deployment offers sandboxes. */
export function sandboxOffered(settings: SandboxSettings): boolean {
	return settings.SANDBOX !== undefined;
}
