/**
 * Stands in for the model providers' APIs in Worker tests: it lists models for the keys it was
 * given and refuses any other key, the way each provider answers `GET .../models`. Anthropic's
 * `POST /v1/messages` streams `reply` back, the way a chat turn reads it, unless `script` answers.
 * Set `workersAi` and api.cloudflare.com answers as Workers AI does: the catalog search lists its
 * models, and `POST .../ai/v1/chat/completions` streams `reply` as OpenAI-compatible chunks.
 */
import type { ModelProvider } from "@gateweave/agents-model";

export const MODEL_HOSTS: Record<string, ModelProvider> = {
	"api.anthropic.com": "anthropic",
	"api.openai.com": "openai",
	"generativelanguage.googleapis.com": "google",
	"api.cloudflare.com": "workers-ai",
};

/** A model in Workers AI's catalog, with whether it calls tools (`function_calling`). */
export interface CatalogModel {
	name: string;
	functionCalling: boolean;
}

/** What Workers AI accepts: the deployment's token for its account, and the catalog it lists. */
export interface FakeWorkersAi {
	token: string;
	account: string;
	catalog: CatalogModel[];
}

export class FakeModels {
	/** Every request it answered, for checking where keys went. */
	readonly requests: { url: string; headers: Headers; body: string }[] = [];
	/** What Anthropic's models answer to any message. */
	reply = "Looks good.";
	/** Answers a message in place of `reply` when it returns a response, as a turn that calls tools. */
	script?: (body: { tools?: { name: string }[]; messages: unknown[] }) => Response | undefined;
	/** Workers AI, as the deployment sets it up; api.cloudflare.com refuses everyone when unset. */
	workersAi?: FakeWorkersAi;
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
		if (provider === "workers-ai") return this.#workersAi(request);
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

	#workersAi(request: Request): Response {
		const fake = this.workersAi;
		const { pathname } = new URL(request.url);
		const prefix = `/client/v4/accounts/${fake?.account}/ai/`;
		if (!fake || request.headers.get("authorization") !== `Bearer ${fake.token}`) {
			return Response.json(
				{ success: false, errors: [{ code: 10000, message: "Authentication error" }] },
				{ status: 403 },
			);
		}
		if (!pathname.startsWith(prefix)) {
			return Response.json({ success: false, errors: [{ message: "Not found" }] }, { status: 404 });
		}
		const route = pathname.slice(prefix.length);
		if (route === "models/search" && request.method === "GET") {
			return Response.json({
				success: true,
				result: fake.catalog.map(({ name, functionCalling }) => ({
					id: `id-${name}`,
					name,
					task: { name: "Text Generation" },
					properties: [
						{ property_id: "context_window", value: "128000" },
						{ property_id: "function_calling", value: String(functionCalling) },
					],
				})),
				result_info: { page: 1, per_page: 200, count: fake.catalog.length, total_pages: 1 },
			});
		}
		if (route === "v1/chat/completions" && request.method === "POST") {
			return completionStream(this.reply);
		}
		return Response.json({ success: false, errors: [{ message: "Not found" }] }, { status: 404 });
	}
}

/** Workers AI's streamed answer, as `POST /ai/v1/chat/completions` sends it. */
function completionStream(text: string): Response {
	return completionChunks([
		{ delta: { role: "assistant", content: text }, finish: null, usage: [600, 3] },
		{ delta: {}, finish: "stop", usage: [620, 5] },
	]);
}

/** Chunks that carry their usage as Workers AI does: the last one holds the request's totals. */
function completionChunks(
	chunks: { delta: object; finish: string | null; usage: [number, number] }[],
): Response {
	const body = chunks
		.map(({ delta, finish, usage: [prompt, completion] }) => {
			const chunk = {
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "@cf/meta/llama-4-scout-17b-16e-instruct",
				choices: [{ index: 0, delta, finish_reason: finish }],
				usage: {
					prompt_tokens: prompt,
					completion_tokens: completion,
					total_tokens: prompt + completion,
				},
			};
			return `data: ${JSON.stringify(chunk)}\n\n`;
		})
		.join("");
	return new Response(`${body}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
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
