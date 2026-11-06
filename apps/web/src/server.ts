import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { db } from "./server/auth";
import { handleChatRequest, isChatRequest } from "./server/chat";
import { pruneExpired } from "./server/db/prune";

export { SandboxMeterDO } from "@gateweave/agents-registry";
export { RunnerSandbox, SandboxOutbound } from "@gateweave/agents-runtime";
export { ConversationAgent } from "./server/conversation";
export { RateLimiter } from "./server/rate-limit";
export { RegistryDO } from "./server/registry-do";

/**
 * A branch's Preview gets none of the Worker's bindings or secrets. Nothing works without the
 * database. Without the secret, Better Auth signs with the default in its source, because with no
 * NODE_ENV on a Worker it does not know this is production. So such a deployment serves nothing else.
 */
function notSetUp() {
	return new Response(
		"This deployment has no database or no BETTER_AUTH_SECRET, so it serves nothing. A Preview of a branch gets neither by itself: see Preview builds in docs/self-hosting.md.\n",
		{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
}

export default {
	fetch(request) {
		if (!env.DB || !env.BETTER_AUTH_SECRET) return notSetUp();
		// Chat is handled before TanStack Start so WebSocket upgrade responses pass through untouched.
		if (isChatRequest(new URL(request.url))) return handleChatRequest(request);
		return handler.fetch(request);
	},
	// Clears what is past its time, once a day.
	async scheduled() {
		await pruneExpired(db);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
