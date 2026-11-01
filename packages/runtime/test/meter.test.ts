import { describe, expect, it } from "vitest";
import {
	type EngineMeter,
	type MeteredRequest,
	meteredRequest,
	meterModelRequest,
	meterResponse,
} from "../src/meter";
import { isMeteredRequest } from "../src/outbound";
import type { ScriptedAnswer } from "./fake-sandbox";
import { type AnswerUsage, anthropicAnswer, googleAnswer, openaiAnswer } from "./support";

/** The answer as a provider sends it, and what the meter reported of it once the CLI read it. */
async function metered(
	provider: "anthropic" | "openai" | "google",
	{ answer }: ScriptedAnswer,
	headers: Record<string, string> = {},
) {
	const original = new Response(answer.body, {
		status: answer.status ?? 200,
		headers: { "content-type": answer.contentType ?? "text/event-stream", ...headers },
	});
	const reports: MeteredRequest[] = [];
	const response = meterResponse(provider, original, Date.now(), (request) =>
		reports.push(request),
	);
	const body = await response.text();
	return { body, reports, response };
}

const answers: Record<"anthropic" | "openai" | "google", (usage?: AnswerUsage) => ScriptedAnswer> =
	{ anthropic: anthropicAnswer, openai: openaiAnswer, google: googleAnswer };

describe("a model request metered where it leaves the sandbox", () => {
	it("reaches the CLI as the provider sent it, and reports its usage once it has been read", async () => {
		const answer = anthropicAnswer({ input: 100, output: 20, cacheRead: 1_000, cacheWrite: 50 });
		const { body, reports, response } = await metered("anthropic", answer, {
			"cf-aig-log-id": "log-1",
			"content-length": String(new TextEncoder().encode(answer.answer.body).length),
		});

		expect(body).toBe(answer.answer.body);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		// Its length is the stream's to give as it goes.
		expect(response.headers.has("content-length")).toBe(false);
		expect(reports).toEqual([
			{
				model: "claude-sonnet-5-5",
				// Anthropic counts cached input apart; the trace counts it in the input too.
				tokens: { input: 1_150, output: 20, cacheRead: 1_000, cacheWrite: 50 },
				finishReason: "stop",
				firstTokenMs: expect.any(Number),
				gatewayLogId: "log-1",
				error: null,
			},
		]);
		expect(meteredRequest.safeParse(reports[0]).success).toBe(true);
	});

	it("reads Anthropic's answer that is not a stream", async () => {
		const answer = {
			type: "message",
			model: "claude-haiku-5-5",
			stop_reason: "tool_use",
			content: [{ type: "text", text: "Hi" }],
			usage: { input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 200 },
		};
		const { reports } = await metered("anthropic", {
			answer: { contentType: "application/json", body: JSON.stringify(answer) },
		});
		expect(reports[0]).toMatchObject({
			model: "claude-haiku-5-5",
			tokens: { input: 230, output: 4, cacheRead: 200, cacheWrite: 0 },
			finishReason: "tool-calls",
			error: null,
		});
	});

	it("reads OpenAI's usage from the response's last event, the cached input in the input", async () => {
		const { reports } = await metered(
			"openai",
			openaiAnswer({ input: 1_200, cacheRead: 1_000, output: 50, toolCalls: true }),
		);
		expect(reports[0]).toMatchObject({
			model: "gpt-5.5",
			tokens: { input: 1_200, output: 50, cacheRead: 1_000, cacheWrite: 0 },
			finishReason: "tool-calls",
			error: null,
		});
		const { reports: cut } = await metered("openai", openaiAnswer({ stop: "incomplete" }));
		expect(cut[0]).toMatchObject({ finishReason: "length", error: null });
	});

	it("reads Google's usage from its last chunk, with its thinking in the output", async () => {
		const { body } = googleAnswer({
			input: 500,
			cacheRead: 100,
			output: 40,
			toolCalls: true,
		}).answer;
		const thinking = body.replace(
			'"candidatesTokenCount":40',
			'"candidatesTokenCount":40,"thoughtsTokenCount":60',
		);
		const { reports } = await metered("google", { answer: { body: thinking } });
		expect(reports[0]).toMatchObject({
			model: "gemini-3.5-flash-lite",
			tokens: { input: 500, output: 100, cacheRead: 100, cacheWrite: 0 },
			finishReason: "tool-calls",
			error: null,
		});
	});

	it("records a refused request as failed in the app's words, never quoting the provider", async () => {
		for (const provider of ["anthropic", "openai", "google"] as const) {
			const { body, reports, response } = await metered(provider, {
				answer: {
					status: 401,
					contentType: "application/json",
					body: '{"error":{"message":"Incorrect API key provided: sk-gatew****lder."}}',
				},
			});
			// The CLI reads the provider's own answer, to say what went wrong in its words.
			expect(response.status).toBe(401);
			expect(body).toContain("sk-gatew");
			expect(reports).toHaveLength(1);
			expect(reports[0]?.finishReason).toBe("error");
			expect(reports[0]?.error).toMatch(/refused the workspace's key\.$/);
			expect(JSON.stringify(reports)).not.toContain("sk-gatew");
		}
	});

	it("records an answer that failed as it streamed, with what it had used", async () => {
		const body = [
			{
				type: "message_start",
				message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10 } },
			},
			{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		const { reports } = await metered("anthropic", { answer: { body } });
		expect(reports[0]).toMatchObject({
			tokens: { input: 10 },
			finishReason: "error",
			error: "Anthropic's answer failed: overloaded_error",
		});
	});

	it("records what an answer the CLI stopped reading had used, and stops it there", async () => {
		const encoder = new TextEncoder();
		let cancelled = false;
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 40, output_tokens: 1 } } })}\n\n`,
					),
				);
			},
			cancel() {
				cancelled = true;
			},
		});
		const reports: MeteredRequest[] = [];
		const response = meterResponse(
			"anthropic",
			new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
			Date.now(),
			(request) => reports.push(request),
		);
		const reader = response.body?.getReader();
		await reader?.read();
		await reader?.cancel();

		expect(cancelled).toBe(true);
		expect(reports).toEqual([
			expect.objectContaining({
				tokens: { input: 40, output: 1, cacheRead: 0, cacheWrite: 0 },
				finishReason: "error",
				error: "Anthropic's answer stopped before it ended.",
			}),
		]);
	});

	it("reads each provider's answer however its bytes are split", async () => {
		for (const provider of ["anthropic", "openai", "google"] as const) {
			const answer = answers[provider]({ input: 70, output: 9 });
			const bytes = new TextEncoder().encode(answer.answer.body);
			const split = new ReadableStream<Uint8Array>({
				start(controller) {
					for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
					controller.close();
				},
			});
			const reports: MeteredRequest[] = [];
			const response = meterResponse(
				provider,
				new Response(split, { headers: { "content-type": "text/event-stream" } }),
				Date.now(),
				(request) => reports.push(request),
			);
			expect(await response.text()).toBe(answer.answer.body);
			expect(reports[0]).toMatchObject({ tokens: { input: 70, output: 9 }, error: null });
		}
	});
});

describe("meterModelRequest", () => {
	/** A conversation that records what it is told, with `turn` false once its turn has ended. */
	function conversation(turn = true) {
		const ended: { token: string; step: number; request: MeteredRequest }[] = [];
		const meter: EngineMeter = {
			engineRequestStarted: async (token) => (turn && token === "turn" ? 3 : null),
			engineRequestEnded: async (token, step, request) => {
				ended.push({ token, step, request });
			},
		};
		return { meter, ended };
	}

	it("starts the request's span before it goes, and ends it once the answer has been read", async () => {
		const { meter, ended } = conversation();
		const waiting: Promise<unknown>[] = [];
		const response = await meterModelRequest(
			meter,
			"turn",
			"anthropic",
			async () =>
				new Response(anthropicAnswer({ output: 12 }).answer.body, {
					headers: { "content-type": "text/event-stream; charset=utf-8" },
				}),
			(promise) => waiting.push(promise),
		);
		await response.text();
		await Promise.all(waiting);
		expect(ended).toMatchObject([{ token: "turn", step: 3, request: { tokens: { output: 12 } } }]);
	});

	it("sends the request unmetered when no turn takes it", async () => {
		const { meter, ended } = conversation(false);
		const waiting: Promise<unknown>[] = [];
		const response = await meterModelRequest(
			meter,
			"turn",
			"anthropic",
			async () => new Response("ok"),
			(promise) => waiting.push(promise),
		);
		expect(await response.text()).toBe("ok");
		await Promise.all(waiting);
		expect(ended).toEqual([]);
	});

	it("records a request that could not be sent as failed, and passes the failure on", async () => {
		const { meter, ended } = conversation();
		const waiting: Promise<unknown>[] = [];
		await expect(
			meterModelRequest(
				meter,
				"turn",
				"openai",
				async () => {
					throw new Error("network");
				},
				(promise) => waiting.push(promise),
			),
		).rejects.toThrow("network");
		await Promise.all(waiting);
		expect(ended).toMatchObject([
			{ step: 3, request: { finishReason: "error", error: "OpenAI could not be reached." } },
		]);
	});
});

describe("isMeteredRequest", () => {
	it("leaves out Anthropic's token counts, which no model answers", () => {
		expect(isMeteredRequest(new URL("https://api.anthropic.com/v1/messages"))).toBe(true);
		expect(isMeteredRequest(new URL("https://api.anthropic.com/v1/messages/count_tokens"))).toBe(
			false,
		);
		expect(isMeteredRequest(new URL("https://api.openai.com/v1/responses"))).toBe(true);
	});
});
