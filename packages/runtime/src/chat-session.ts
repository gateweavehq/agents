import { z } from "zod";

/** Where the app's gateway puts the session a chat socket was opened with. */
export const CHAT_SESSION_HEADER = "x-gateweave-chat-session";

/** Closes a socket whose session has ended, with the code Track's sync sockets use for it. */
export const SESSION_ENDED = 4401;

const chatSession = z.object({
	id: z.string().min(1),
	userId: z.string().min(1),
	expiresAt: z.number(),
});

export type ChatSession = z.infer<typeof chatSession>;

/** The session the gateway checked when it let this socket through; null without one. */
export function sessionOpening(request: Request): ChatSession | null {
	const value = request.headers.get(CHAT_SESSION_HEADER);
	if (!value) return null;
	try {
		const parsed = chatSession.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
