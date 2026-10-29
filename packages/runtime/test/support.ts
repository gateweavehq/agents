/** What the runtime's tests share: a chat socket, and a model that answers as a provider does. */
import { vi } from "vitest";

export const KEY = "sk-ant-api03-secret-abcd";

export async function connect(stub: {
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
}) {
	const response = await stub.fetch("http://conversation/", { headers: { Upgrade: "websocket" } });
	const socket = response.webSocket;
	if (!socket) throw new Error(`No WebSocket: ${response.status}`);
	socket.accept();
	return socket;
}

export interface Turn {
	text: string;
	error: string | null;
	/** Every frame of the turn as it arrived, to check what reached the browser. */
	raw: string[];
}

/** Sends a message the way the chat page does, and reads the turn until it ends. */
export function ask(socket: WebSocket, text: string, id = crypto.randomUUID()): Promise<Turn> {
	return new Promise((resolve) => {
		const turn: Turn = { text: "", error: null, raw: [] };
		socket.addEventListener("message", (event) => {
			const raw = String(event.data);
			const frame = JSON.parse(raw) as {
				type: string;
				id?: string;
				body?: string;
				done?: boolean;
				error?: boolean;
			};
			if (frame.type !== "cf_agent_use_chat_response" || frame.id !== id) return;
			turn.raw.push(raw);
			if (frame.error) {
				turn.error = frame.body ?? "";
				return resolve(turn);
			}
			if (frame.body?.trim()) {
				const chunk = JSON.parse(frame.body) as {
					type: string;
					delta?: string;
					errorText?: string;
				};
				if (chunk.type === "text-delta") turn.text += chunk.delta ?? "";
				if (chunk.type === "error") turn.error = chunk.errorText ?? "";
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

/** Anthropic's streamed answer, as `POST /v1/messages` sends it. */
export function anthropicStream(
	text: string,
	{ end = true, headers = {} }: { end?: boolean; headers?: Record<string, string> } = {},
): Response {
	const events: [string, unknown][] = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		],
		[
			"content_block_start",
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		],
		[
			"content_block_delta",
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		],
	];
	if (end) {
		events.push(
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			[
				"message_delta",
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 5 },
				},
			],
			["message_stop", { type: "message_stop" }],
		);
	}
	const body = events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");
	const encoded = new TextEncoder().encode(body);
	// An answer that does not end keeps its stream open, as a slow model's does.
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoded);
			if (end) controller.close();
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", ...headers } });
}

export interface ModelRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
	signal: AbortSignal | null;
}

/**
 * Answers each model request with `answer`, given how many came before it and the request itself.
 * Requests to a host in `others` go to its handler instead, as an MCP server's do.
 */
export function fakeModel(
	answer: (call: number, request: ModelRequest) => Response | Promise<Response>,
	others: Record<string, (request: Request) => Promise<Response>> = {},
) {
	const requests: ModelRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const other = others[new URL(request.url).host];
		if (other) return other(request);
		const recorded = {
			url: request.url,
			headers: request.headers,
			body: (await request.clone().json()) as Record<string, unknown>,
			signal: init?.signal ?? null,
		};
		requests.push(recorded);
		return answer(requests.length - 1, recorded);
	});
	return requests;
}

/** One streamed chunk of `POST /ai/v1/chat/completions`, as Workers AI sends it. */
interface CompletionChunk {
	delta: Record<string, unknown>;
	finish?: "stop" | "tool_calls";
	/** The tokens this chunk adds, or on the last chunk, the totals for the request. */
	usage: { prompt_tokens: number; completion_tokens: number };
}

/** A streamed OpenAI-compatible answer: each chunk with its usage, then `[DONE]`. */
export function completionStream(chunks: CompletionChunk[]): Response {
	const body = chunks
		.map(({ delta, finish, usage }, index) => {
			const last = index === chunks.length - 1;
			return `data: ${JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "@cf/meta/llama-4-scout-17b-16e-instruct",
				choices: [{ index: 0, delta, finish_reason: finish ?? null }],
				usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
				// Workers AI's own measure of what the request cost, on the last chunk.
				...(last ? { neurons: 42 } : {}),
			})}\n\n`;
		})
		.join("");
	return new Response(`${body}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

/** Anthropic's streamed answer that calls one tool, as `POST /v1/messages` sends it. */
export function anthropicToolCall(name: string, input: object): Response {
	const events: [string, unknown][] = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_tool",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 20, output_tokens: 1 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name, input: {} },
			},
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 8 },
			},
		],
		["message_stop", { type: "message_stop" }],
	];
	const body = events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
