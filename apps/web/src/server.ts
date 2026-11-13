import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { db, handleAuthRequest } from "./server/auth";
import { handleChatRequest, isChatRequest } from "./server/chat";
import { pruneExpired } from "./server/db/prune";
import { retryErasures } from "./server/erasure";
import { handleMcpRequest, isMcpRequest } from "./server/mcp";
import { moveWorkspaces } from "./server/move";
import { newNonce, withSecurityHeaders } from "./server/security-headers";

export { SandboxMeterDO } from "@gateweave/agents-registry";
export { RunnerSandbox, SandboxOutbound } from "@gateweave/agents-runtime";
export { Backup } from "./server/backup";
export { ConversationAgent } from "./server/conversation";
export { RateLimiter } from "./server/rate-limit";
export { RegistryDO } from "./server/registry-do";
export { WikiWorkflow } from "./server/wiki/workflow";

/** OAuth discovery documents for MCP clients. Better Auth serves them at the root. */
const OAUTH_DISCOVERY =
	/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/|$)/;

/**
 * A branch's Preview gets none of the Worker's bindings or secrets, and accounts can't be run safely
 * without the database and the secret. So such a deployment serves nothing else.
 */
function notSetUp() {
	return new Response(
		"This deployment has no database or no BETTER_AUTH_SECRET, so it serves nothing. A Preview of a branch gets neither by itself: see Preview builds in docs/self-hosting.md.\n",
		{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
}

function route(request: Request, nonce: string): Response | Promise<Response> {
	if (!env.DB || !env.BETTER_AUTH_SECRET) return notSetUp();
	const url = new URL(request.url);
	// Agents that read Agents sign in with OAuth and call here; no cookies, and no TanStack Start.
	if (isMcpRequest(url)) return handleMcpRequest(request);
	if (OAUTH_DISCOVERY.test(url.pathname)) return handleAuthRequest(request);
	// Chat is handled before TanStack Start so WebSocket upgrade responses pass through untouched.
	if (isChatRequest(url)) return handleChatRequest(request);
	return handler.fetch(request, { context: { nonce } });
}

export default {
	async fetch(request) {
		const nonce = newNonce();
		const response = await route(request, nonce);
		// Vite's dev server adds inline scripts of its own for hot reload, which have no nonce.
		if (import.meta.env.DEV) return response;
		return withSecurityHeaders(request, response, { nonce, oidcIssuer: env.OIDC_ISSUER });
	},
	// Clears what is past its time, once a day, and moves a few workspaces into the deployment's
	// jurisdiction while any are elsewhere.
	async scheduled() {
		await retryErasures(db);
		await pruneExpired(db);
		await moveWorkspaces(db);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
