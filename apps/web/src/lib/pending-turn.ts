/**
 * A turn the conversation has taken whose reply has not begun: it waits for its MCP servers, or its
 * sandbox starts. The chat hook shows a turn it sent itself as running from the start, but a page
 * that opens in that time, or a socket that comes back, hears only that a turn is pending, and the
 * hook says nothing of it until the reply's first frame. This reads those frames, so the page can
 * show the turn as running, and stop it, in the meantime.
 */

/** The turn that is waiting to begin, by its request's id when the server named it, or null. */
export type PendingTurn = { id: string | null } | null;

/** What stopping a turn sends: the frame the chat hook sends for a turn it knows. */
export function stopFrame(id: string): string {
	return JSON.stringify({ type: "cf_agent_chat_request_cancel", id });
}

/**
 * The pending turn after one more frame from the conversation's socket. The server keeps a socket
 * that asked for a turn to pick up waiting (`cf_agent_stream_pending`), and always follows up: the
 * reply began (`cf_agent_stream_resuming`, or a frame of the reply itself), or the turn ended with
 * no reply (`cf_agent_stream_resume_none`). Returns `pending` itself when nothing changed.
 */
export function pendingTurnAfter(pending: PendingTurn, frame: string): PendingTurn {
	// Most frames are a reply's, and long: only these are worth reading.
	if (!frame.includes("cf_agent_stream_") && pending === null) return pending;
	let data: { type?: unknown; id?: unknown };
	try {
		data = JSON.parse(frame);
	} catch {
		return pending;
	}
	if (typeof data !== "object" || data === null) return pending;
	switch (data.type) {
		case "cf_agent_stream_pending": {
			const id = typeof data.id === "string" ? data.id : null;
			return pending !== null && pending.id === id ? pending : { id };
		}
		case "cf_agent_stream_resuming":
		case "cf_agent_stream_resume_none":
			return null;
		case "cf_agent_use_chat_response":
			// Another turn's frame says nothing of this one.
			return pending === null || pending.id === null || pending.id === data.id ? null : pending;
		default:
			return pending;
	}
}
