import handler from "@tanstack/react-start/server-entry";
import { handleChatRequest, isChatRequest } from "./server/chat";

export { SandboxMeterDO } from "@gateweave/agents-registry";
export { ConversationAgent, RunnerSandbox, SandboxOutbound } from "@gateweave/agents-runtime";
export { RateLimiter } from "./server/rate-limit";
export { RegistryDO } from "./server/registry-do";

export default {
	fetch(request) {
		// Chat is handled before TanStack Start so WebSocket upgrade responses pass through untouched.
		if (isChatRequest(new URL(request.url))) return handleChatRequest(request);
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
