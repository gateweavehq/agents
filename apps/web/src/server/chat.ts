import { env } from "cloudflare:workers";
import { conversationName } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { db, getAuth } from "./auth";
import { registryFor } from "./registry";
import { findMembership } from "./workspaces";

const CHAT_ROUTE = /^\/api\/chat\/([^/]+)\/([\w-]{1,64})(\/get-messages)?$/;

export function isChatRequest(url: URL): boolean {
	return url.pathname.startsWith("/api/chat/");
}

/**
 * Gateway to conversations with agents. A conversation's Durable Object has no public route;
 * every request passes through here, where the session, the membership in D1 and the
 * conversation's owner are checked. Anyone else gets the same 404 as for a missing conversation.
 *
 *   GET /api/chat/:slug/:conversationId               WebSocket for the conversation
 *   GET /api/chat/:slug/:conversationId/get-messages  its messages (JSON), which the client reads first
 */
export async function handleChatRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = CHAT_ROUTE.exec(url.pathname);
	if (!match) return error(404, "Conversation not found");

	const [, slug = "", conversationId = "", messages] = match;
	const isSocket = messages === undefined;
	if (request.method !== "GET") return error(405, "Method not allowed");
	if (isSocket && request.headers.get("Upgrade") !== "websocket") {
		return error(426, "Expected a WebSocket upgrade");
	}
	// Session cookies ride along on cross-site WebSocket handshakes, so the origin must match.
	const origin = request.headers.get("Origin");
	if ((isSocket || origin) && origin !== url.origin) return error(403, "Cross-origin request");

	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return error(401, "Not signed in");
	const membership = await findMembership(db, decodeURIComponent(slug), session.user.id);
	if (!membership) return error(404, "Conversation not found");
	const conversation = await registryFor(membership.workspaceId).getConversation(
		conversationId,
		session.user.id,
	);
	if (!conversation) return error(404, "Conversation not found");

	const agent = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(membership.workspaceId, conversation.id),
	);
	// Only what the conversation needs goes on: the cookies stay here. The query carries the
	// client's connection id, which resuming a stream after a reconnect relies on.
	const target = `https://conversation/${isSocket ? "" : "get-messages"}${url.search}`;
	return agent.fetch(target, { headers: isSocket ? { Upgrade: "websocket" } : {} });
}

function error(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}
