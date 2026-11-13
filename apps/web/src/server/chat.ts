import { CHAT_SESSION_HEADER, type ChatSession } from "@gateweave/agents-runtime";
import { db, getAuth } from "./auth";
import { conversationFor, registryFor } from "./registry";
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
 *   HEAD /api/chat/:slug/:conversationId              204 if that socket would open, else the refusal
 *   GET /api/chat/:slug/:conversationId/get-messages  its messages (JSON), which the client reads first
 *
 * The browser hides why a WebSocket handshake failed, so the page asks with HEAD. Like the handshake
 * it says only what the caller may know, and it goes no further than the checks.
 */
export async function handleChatRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = CHAT_ROUTE.exec(url.pathname);
	if (!match) return error(404, "Conversation not found");

	const [, slug = "", conversationId = "", messages] = match;
	const isSocket = messages === undefined;
	const isProbe = isSocket && request.method === "HEAD";
	if (request.method !== "GET" && !isProbe) return error(405, "Method not allowed");
	if (isSocket && !isProbe && request.headers.get("Upgrade") !== "websocket") {
		return error(426, "Expected a WebSocket upgrade");
	}
	// Session cookies ride along on cross-site WebSocket handshakes, so the origin must match.
	const origin = request.headers.get("Origin");
	if (((isSocket && !isProbe) || origin) && origin !== url.origin) {
		return error(403, "Cross-origin request");
	}

	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return error(401, "Not signed in");
	const membership = await findMembership(db, decodeURIComponent(slug), session.user.id);
	if (!membership) return error(404, "Conversation not found");
	const conversation = await registryFor(membership).getConversation(
		conversationId,
		session.user.id,
	);
	if (!conversation) return error(404, "Conversation not found");
	if (isProbe) return new Response(null, { status: 204 });

	const agent = await conversationFor(membership, conversation.id);
	// Only what the conversation needs goes on: the cookies stay here, and a socket takes the
	// session's id instead, which the conversation checks before each message. The query carries
	// the client's connection id, which resuming a stream after a reconnect relies on.
	const target = `https://conversation/${isSocket ? "" : "get-messages"}${url.search}`;
	if (!isSocket) return agent.fetch(target);
	const opened: ChatSession = {
		id: session.session.id,
		userId: session.user.id,
		expiresAt: new Date(session.session.expiresAt).getTime(),
	};
	return agent.fetch(target, {
		headers: { Upgrade: "websocket", [CHAT_SESSION_HEADER]: JSON.stringify(opened) },
	});
}

function error(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}
