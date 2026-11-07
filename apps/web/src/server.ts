import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { db } from "./server/auth";
import { handleChatRequest, isChatRequest } from "./server/chat";
import { pruneExpired } from "./server/db/prune";
import { retryErasures } from "./server/erasure";
import { newNonce, withSecurityHeaders } from "./server/security-headers";

export { SandboxMeterDO } from "@gateweave/agents-registry";
export { RunnerSandbox, SandboxOutbound } from "@gateweave/agents-runtime";
export { ConversationAgent } from "./server/conversation";
export { RateLimiter } from "./server/rate-limit";
export { RegistryDO } from "./server/registry-do";

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
	// Chat is handled before TanStack Start so WebSocket upgrade responses pass through untouched.
	if (isChatRequest(new URL(request.url))) return handleChatRequest(request);
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
	// Clears what is past its time, once a day.
	async scheduled() {
		await retryErasures(db);
		await pruneExpired(db);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
