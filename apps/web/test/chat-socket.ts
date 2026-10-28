import type { WebSocket } from "miniflare";

/** Sends a message the way the chat page does, and reads the reply until the turn ends. */
export function ask(socket: WebSocket, text: string): Promise<{ text: string; raw: string[] }> {
	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const turn = { text: "", raw: [] as string[] };
		socket.addEventListener("message", (event) => {
			const raw = String(event.data);
			const frame = JSON.parse(raw) as { type: string; id?: string; body?: string; done?: boolean };
			if (frame.type !== "cf_agent_use_chat_response" || frame.id !== id) return;
			turn.raw.push(raw);
			if (frame.body?.trim()) {
				const chunk = JSON.parse(frame.body) as {
					type: string;
					delta?: string;
					errorText?: string;
				};
				if (chunk.type === "text-delta") turn.text += chunk.delta ?? "";
				if (chunk.type === "error") reject(new Error(chunk.errorText));
			}
			if (frame.done) resolve(turn);
		});
		socket.send(
			JSON.stringify({
				type: "cf_agent_use_chat_request",
				id,
				init: {
					method: "POST",
					body: JSON.stringify({
						messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }],
						trigger: "submit-message",
					}),
				},
			}),
		);
	});
}
