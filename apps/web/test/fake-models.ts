/**
 * Stands in for the model providers' APIs in Worker tests: it lists models for the keys it was
 * given and refuses any other key, the way each provider answers `GET .../models`. Anthropic's
 * `POST /v1/messages` streams `reply` back, the way a chat turn reads it, unless `script` answers.
 */
import type { ModelProvider } from "@gateweave/agents-model";

export const MODEL_HOSTS: Record<string, ModelProvider> = {
	"api.anthropic.com": "anthropic",
	"api.openai.com": "openai",
	"generativelanguage.googleapis.com": "google",
};

export class FakeModels {
	/** Every request it answered, for checking where keys went. */
	readonly requests: { url: string; headers: Headers; body: string }[] = [];
	/** What Anthropic's models answer to any message. */
	reply = "Looks good.";
	/** Answers a message in place of `reply` when it returns a response, as a turn that calls tools. */
	script?: (body: { tools?: { name: string }[]; messages: unknown[] }) => Response | undefined;
	readonly #keys: Map<string, { provider: ModelProvider; models: string[] }>;

	constructor(keys: Record<string, { provider: ModelProvider; models: string[] }>) {
		this.#keys = new Map(Object.entries(keys));
	}

	async handle(request: Request): Promise<Response> {
		this.requests.push({
			url: request.url,
			headers: new Headers(request.headers),
			body: request.method === "POST" ? await request.text() : "",
		});
		const provider = MODEL_HOSTS[new URL(request.url).host];
		const key =
			provider === "anthropic"
				? request.headers.get("x-api-key")
				: provider === "google"
					? request.headers.get("x-goog-api-key")
					: request.headers.get("authorization")?.replace(/^Bearer /, "");
		const known = key ? this.#keys.get(key) : undefined;
		if (!provider || !known || known.provider !== provider) {
			return Response.json(
				{ error: { message: `Incorrect API key provided: ${key}` } },
				{ status: 401 },
			);
		}
		if (provider === "anthropic" && request.method === "POST") {
			const body = JSON.parse(this.requests.at(-1)?.body ?? "{}");
			return this.script?.(body) ?? anthropicStream(this.reply);
		}
		if (provider === "google") {
			return Response.json({
				models: known.models.map((id) => ({
					name: `models/${id}`,
					displayName: id,
					supportedGenerationMethods: ["generateContent"],
				})),
			});
		}
		return Response.json({
			data: known.models.map((id, index) => ({ id, display_name: id, created: index })),
			has_more: false,
		});
	}
}

/** Anthropic's streamed answer that calls one tool, as `POST /v1/messages` sends it. */
export function anthropicToolCall(name: string, input: object): Response {
	return eventStream([
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_tool",
					type: "message",
					role: "assistant",
					model: "claude",
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
	]);
}

/** Anthropic's streamed answer, as `POST /v1/messages` sends it. */
function anthropicStream(text: string): Response {
	const events: [string, unknown][] = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude",
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
	];
	return eventStream(events);
}

function eventStream(events: [string, unknown][]): Response {
	const body = events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
