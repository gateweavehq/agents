/**
 * An engine's model requests, metered where they leave the sandbox (AGT-49). `SandboxOutbound`
 * sees every request a CLI makes for the model, since it adds the workspace's key to it. So the
 * run's trace takes its model spans from there, one per request, with the usage the provider's
 * answer reports, and not from the CLI's own events, which leave out what a CLI does not print:
 * OpenCode's `task` subagents, parts of Claude Code's subagents, Codex's requests apart.
 *
 * The answer streams on to the CLI as it comes; a copy of each chunk is read on the side for its
 * usage. Only the usage, the model, how the answer ended and its timing are kept, never a body.
 */
import {
	MODEL_PROVIDER_NAMES,
	type ModelProvider,
	type RequestTokens,
} from "@gateweave/agents-model";
import { z } from "zod";
import { failureForLogs } from "./models";

/** A request for the model as it left the sandbox, which the conversation records as a span. */
export interface MeteredRequest {
	/** The model the provider says answered; null when it did not say. */
	model: string | null;
	tokens: RequestTokens;
	/** How the answer ended, in the AI SDK's words where there is one. */
	finishReason: string | null;
	/** How long the answer's first bytes took, from when the request went out. */
	firstTokenMs: number | null;
	gatewayLogId: string | null;
	/** Why the request failed, in the app's words; null when it answered. */
	error: string | null;
}

const count = z.number().int().nonnegative().max(1e12);

/** What the conversation accepts as a metered request: it comes over RPC, from the Worker. */
export const meteredRequest = z.object({
	model: z.string().max(200).nullable(),
	tokens: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }),
	finishReason: z.string().max(40).nullable(),
	firstTokenMs: count.nullable(),
	gatewayLogId: z.string().max(200).nullable(),
	error: z.string().max(500).nullable(),
});

/** Where the sandbox's requests for the model are recorded: the conversation of the turn. */
export interface EngineMeter {
	/** A request went out. The step of its span, or null when no such turn runs. */
	engineRequestStarted(token: string): Promise<number | null>;
	/** The request's answer ended, or it failed. */
	engineRequestEnded(token: string, step: number, request: MeteredRequest): Promise<void>;
}

/** AI Gateway's id for a request's log entry, on its response. */
const GATEWAY_LOG_ID = "cf-aig-log-id";

/** The most of an answer that is not a stream kept to read its usage: more is not a model's. */
const MAX_JSON_BYTES = 8_000_000;

/** The longest line of a stream read for its usage. A longer one is skipped. */
const MAX_EVENT_BYTES = 8_000_000;

/**
 * Sends a request for the model and meters it: its span starts as it goes, and ends with what the
 * answer reported once the CLI has read it all, or stopped reading. `waitUntil` keeps the Worker
 * up until the conversation has that.
 */
export async function meterModelRequest(
	meter: EngineMeter,
	token: string,
	provider: ModelProvider,
	send: () => Promise<Response>,
	waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
	const step = await meter.engineRequestStarted(token).catch((error: unknown) => {
		console.error("A sandbox's model request was not metered", failureForLogs(error));
		return null;
	});
	if (step === null) return send();
	let ended!: (request: MeteredRequest) => void;
	const report = new Promise<MeteredRequest>((resolve) => {
		ended = resolve;
	});
	waitUntil(
		report
			.then((request) => meter.engineRequestEnded(token, step, request))
			.catch((error: unknown) =>
				console.error("A sandbox's model request was not recorded", failureForLogs(error)),
			),
	);
	const sentAt = Date.now();
	let response: Response;
	try {
		response = await send();
	} catch (error) {
		ended(failedRequest(`${MODEL_PROVIDER_NAMES[provider]} could not be reached.`, null));
		throw error;
	}
	return meterResponse(provider, response, sentAt, ended);
}

/**
 * The response as the CLI gets it, the same bytes as they come, with `ended` called once with
 * what its answer reported: when the body ends, when the CLI stops reading it, or at once for an
 * answer that is an error.
 */
export function meterResponse(
	provider: ModelProvider,
	response: Response,
	sentAt: number,
	ended: (request: MeteredRequest) => void,
): Response {
	const gatewayLogId = response.headers.get(GATEWAY_LOG_ID);
	if (!response.ok) {
		ended(failedRequest(describeStatus(provider, response.status), gatewayLogId));
		return response;
	}
	const body = response.body;
	const usage = usageReader(provider);
	if (!body) {
		ended(usage.result(gatewayLogId, null));
		return response;
	}
	const stream = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
	const read = stream ? eventReader(usage) : jsonReader(usage);
	let firstTokenMs: number | null = null;
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		read.end();
		ended(usage.result(gatewayLogId, firstTokenMs));
	};
	const reader = body.getReader();
	const metered = new ReadableStream<Uint8Array>({
		async pull(controller) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (error) {
				usage.broke();
				finish();
				controller.error(error);
				return;
			}
			if (chunk.done) {
				finish();
				controller.close();
				return;
			}
			firstTokenMs ??= Date.now() - sentAt;
			read.push(chunk.value);
			controller.enqueue(chunk.value);
		},
		async cancel(reason) {
			// The CLI stopped reading, as when its turn is stopped: the answer goes no further.
			usage.broke();
			finish();
			await reader.cancel(reason);
		},
	});
	// The body is the decoded one, a stream of no length the Worker knows; it encodes it again as
	// the response's headers say on its way to the CLI.
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(metered, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Takes an answer's events, each a JSON value, and says what they reported. */
interface UsageReader {
	take(event: unknown): void;
	/** The answer stopped before it ended. */
	broke(): void;
	result(gatewayLogId: string | null, firstTokenMs: number | null): MeteredRequest;
}

interface BodyReader {
	push(chunk: Uint8Array): void;
	end(): void;
}

/** Server-sent events: each `data:` line is one JSON event. */
function eventReader(usage: UsageReader): BodyReader {
	const decoder = new TextDecoder();
	let buffer = "";
	let skipping = false;
	const line = (text: string) => {
		const data = /^data: ?(.*)$/.exec(text.replace(/\r$/, ""));
		if (!data?.[1] || data[1] === "[DONE]") return;
		try {
			usage.take(JSON.parse(data[1]));
		} catch {
			// Not JSON: nothing of the usage is in it.
		}
	};
	const lines = () => {
		let end = buffer.indexOf("\n");
		while (end !== -1) {
			if (!skipping) line(buffer.slice(0, end));
			skipping = false;
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
		}
		if (buffer.length > MAX_EVENT_BYTES) {
			buffer = "";
			skipping = true;
		}
	};
	return {
		push(chunk) {
			buffer += decoder.decode(chunk, { stream: true });
			lines();
		},
		end() {
			buffer += decoder.decode();
			lines();
			if (!skipping && buffer !== "") line(buffer);
			buffer = "";
		},
	};
}

/** An answer that is one JSON value, kept whole until it ends unless it is too long. */
function jsonReader(usage: UsageReader): BodyReader {
	const chunks: Uint8Array[] = [];
	let size = 0;
	return {
		push(chunk) {
			size += chunk.length;
			if (size <= MAX_JSON_BYTES) chunks.push(chunk);
		},
		end() {
			if (size > MAX_JSON_BYTES || size === 0) return;
			const body = new Uint8Array(size);
			let at = 0;
			for (const chunk of chunks) {
				body.set(chunk, at);
				at += chunk.length;
			}
			try {
				usage.take(JSON.parse(new TextDecoder().decode(body)));
			} catch {
				// Not JSON: nothing of the usage is in it.
			}
		},
	};
}

function usageReader(provider: ModelProvider): UsageReader {
	switch (provider) {
		case "anthropic":
			return new AnthropicUsage(provider);
		case "openai":
			return new OpenAIUsage(provider);
		case "google":
			return new GoogleUsage(provider);
		default:
			// No engine calls another provider's models from the sandbox (`./outbound.ts`).
			return new BaseUsage(provider);
	}
}

/** What every provider's answer comes down to. */
class BaseUsage implements UsageReader {
	readonly #provider: ModelProvider;
	model: string | null = null;
	tokens: RequestTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	finishReason: string | null = null;
	/** Why the provider said the answer failed, in its words. */
	failure: string | null = null;
	#broke = false;

	constructor(provider: ModelProvider) {
		this.#provider = provider;
	}

	take(_event: unknown): void {}

	broke(): void {
		this.#broke = true;
	}

	result(gatewayLogId: string | null, firstTokenMs: number | null): MeteredRequest {
		const name = MODEL_PROVIDER_NAMES[this.#provider];
		const error =
			this.failure !== null
				? `${name}'s answer failed: ${this.failure}`
				: this.#broke && this.finishReason === null
					? `${name}'s answer stopped before it ended.`
					: null;
		return {
			model: this.model,
			tokens: this.tokens,
			finishReason: error === null ? this.finishReason : "error",
			firstTokenMs,
			gatewayLogId,
			error,
		};
	}
}

const anthropicUsage = z.object({
	input_tokens: z.number().nullish(),
	output_tokens: z.number().nullish(),
	cache_creation_input_tokens: z.number().nullish(),
	cache_read_input_tokens: z.number().nullish(),
});

const anthropicEvent = z.union([
	z.object({
		type: z.literal("message_start"),
		message: z.object({ model: z.string().optional(), usage: anthropicUsage.optional() }),
	}),
	z.object({
		type: z.literal("message_delta"),
		delta: z.object({ stop_reason: z.string().nullish() }).optional(),
		usage: anthropicUsage.optional(),
	}),
	// An answer that is not a stream.
	z.object({
		type: z.literal("message"),
		model: z.string().optional(),
		stop_reason: z.string().nullish(),
		usage: anthropicUsage.optional(),
	}),
	z.object({ type: z.literal("error"), error: z.object({ type: z.string() }).optional() }),
]);

const ANTHROPIC_FINISH: Record<string, string> = {
	end_turn: "stop",
	stop_sequence: "stop",
	tool_use: "tool-calls",
	max_tokens: "length",
	refusal: "content-filter",
};

/**
 * Anthropic's Messages API: the input and cache counts at `message_start`, the output as it grows
 * at each `message_delta`. Each count only grows, so the most seen is the request's.
 */
class AnthropicUsage extends BaseUsage {
	#usage: z.infer<typeof anthropicUsage> = {};

	override take(event: unknown): void {
		const parsed = anthropicEvent.safeParse(event);
		if (!parsed.success) return;
		const data = parsed.data;
		switch (data.type) {
			case "message_start":
				this.model = data.message.model ?? this.model;
				this.#merge(data.message.usage);
				return;
			case "message_delta":
				this.#merge(data.usage);
				this.#finish(data.delta?.stop_reason);
				return;
			case "message":
				this.model = data.model ?? this.model;
				this.#merge(data.usage);
				this.#finish(data.stop_reason);
				return;
			case "error":
				this.failure = data.error?.type ?? "error";
		}
	}

	#finish(reason: string | null | undefined): void {
		if (reason) this.finishReason = ANTHROPIC_FINISH[reason] ?? "other";
	}

	#merge(next: z.infer<typeof anthropicUsage> | undefined): void {
		if (!next) return;
		const known = this.#usage;
		const most = (a: number | null | undefined, b: number | null | undefined) =>
			Math.max(a ?? 0, b ?? 0);
		this.#usage = {
			input_tokens: most(known.input_tokens, next.input_tokens),
			output_tokens: most(known.output_tokens, next.output_tokens),
			cache_creation_input_tokens: most(
				known.cache_creation_input_tokens,
				next.cache_creation_input_tokens,
			),
			cache_read_input_tokens: most(known.cache_read_input_tokens, next.cache_read_input_tokens),
		};
		const cacheRead = this.#usage.cache_read_input_tokens ?? 0;
		const cacheWrite = this.#usage.cache_creation_input_tokens ?? 0;
		// Anthropic counts cached input apart; the trace counts it in the input too.
		this.tokens = {
			input: (this.#usage.input_tokens ?? 0) + cacheRead + cacheWrite,
			output: this.#usage.output_tokens ?? 0,
			cacheRead,
			cacheWrite,
		};
	}
}

const openAIResponse = z.object({
	model: z.string().optional(),
	status: z.string().optional(),
	output: z.array(z.object({ type: z.string() }).loose()).optional(),
	usage: z
		.object({
			input_tokens: z.number().nullish(),
			input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
			output_tokens: z.number().nullish(),
		})
		.nullish(),
	error: z.object({ code: z.string().nullish() }).nullish(),
	incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
});

const openAIEvent = z.union([
	z.object({
		type: z.enum(["response.completed", "response.incomplete", "response.failed"]),
		response: openAIResponse,
	}),
	z.object({ type: z.literal("error"), code: z.string().nullish() }),
	// An answer that is not a stream.
	openAIResponse.extend({ object: z.literal("response") }),
]);

/**
 * OpenAI's Responses API: the whole usage comes with the response's last event, or in the answer
 * when it is not a stream. Cached input counts in the input, as the trace counts it; reasoning in
 * the output.
 */
class OpenAIUsage extends BaseUsage {
	override take(event: unknown): void {
		const parsed = openAIEvent.safeParse(event);
		if (!parsed.success) return;
		const data = parsed.data;
		if ("type" in data && data.type === "error") {
			this.failure = data.code ?? "error";
			return;
		}
		const response = "response" in data ? data.response : (data as z.infer<typeof openAIResponse>);
		this.model = response.model ?? this.model;
		const { usage } = response;
		if (usage) {
			this.tokens = {
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.input_tokens_details?.cached_tokens ?? 0,
				cacheWrite: 0,
			};
		}
		if (response.status === "failed") {
			this.failure = response.error?.code ?? "failed";
		} else if (response.status === "incomplete") {
			const reason = response.incomplete_details?.reason;
			this.finishReason = reason === "content_filter" ? "content-filter" : "length";
		} else if (response.status === "completed") {
			const calls = response.output?.some((item) => item.type.endsWith("_call")) ?? false;
			this.finishReason = calls ? "tool-calls" : "stop";
		}
	}
}

const googleChunk = z.object({
	modelVersion: z.string().optional(),
	candidates: z
		.array(
			z.object({
				finishReason: z.string().optional(),
				content: z.object({ parts: z.array(z.object({}).loose()).optional() }).optional(),
			}),
		)
		.optional(),
	usageMetadata: z
		.object({
			promptTokenCount: z.number().nullish(),
			candidatesTokenCount: z.number().nullish(),
			cachedContentTokenCount: z.number().nullish(),
			thoughtsTokenCount: z.number().nullish(),
		})
		.optional(),
	error: z.object({ status: z.string().optional() }).optional(),
});

/**
 * Google's `generateContent`: each chunk of a stream carries the usage so far, the last the whole
 * of it. Cached input counts in the prompt, as the trace counts it; thinking in the output.
 */
class GoogleUsage extends BaseUsage {
	#calls = false;

	override take(event: unknown): void {
		const parsed = googleChunk.safeParse(event);
		if (!parsed.success) return;
		const data = parsed.data;
		if (data.error) {
			this.failure = data.error.status ?? "error";
			return;
		}
		this.model = data.modelVersion ?? this.model;
		const [candidate] = data.candidates ?? [];
		if (candidate?.content?.parts?.some((part) => "functionCall" in part)) this.#calls = true;
		if (candidate?.finishReason) {
			const reason = candidate.finishReason;
			this.finishReason =
				reason === "MAX_TOKENS"
					? "length"
					: reason === "SAFETY" || reason === "RECITATION"
						? "content-filter"
						: this.#calls
							? "tool-calls"
							: reason === "STOP"
								? "stop"
								: "other";
		}
		const usage = data.usageMetadata;
		if (usage) {
			this.tokens = {
				input: usage.promptTokenCount ?? 0,
				output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
				cacheRead: usage.cachedContentTokenCount ?? 0,
				cacheWrite: 0,
			};
		}
	}
}

/** Why a provider refused a request, in the same words as a turn of Gateweave's own loop. */
function describeStatus(provider: ModelProvider, status: number): string {
	const name = MODEL_PROVIDER_NAMES[provider];
	if (status === 401 || status === 403) return `${name} refused the workspace's key.`;
	if (status === 404) return `${name} has no such model for the workspace's key.`;
	if (status === 429) return `${name} is limiting the workspace's requests.`;
	if (status >= 500) return `${name} could not answer just now.`;
	return `${name} refused the request (status ${status}).`;
}

function failedRequest(error: string, gatewayLogId: string | null): MeteredRequest {
	return {
		model: null,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		finishReason: "error",
		firstTokenMs: null,
		gatewayLogId,
		error,
	};
}
