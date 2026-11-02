/**
 * An engine's request for the model, from the sandbox to its provider (AGT-62). `decideOutbound`
 * has let it through by its address; this reads its body, checks what it asks the provider to do
 * (`checkModelRequest` in `./outbound.ts`), and only then sends it with the workspace's key,
 * metered (`./meter.ts`). A request refused here never reaches the provider, and the run's trace
 * gets a failed span that says why.
 */
import { MODEL_PROVIDER_NAMES } from "@gateweave/agents-model";
import type { RunningEngine } from "./engines";
import { type EngineMeter, meterModelRequest, recordRefusal } from "./meter";
import {
	anthropicRequest,
	type GatewaySettings,
	googleRequest,
	openaiRequest,
	SettingsError,
} from "./models";
import {
	checkModelRequest,
	type EngineProvider,
	isMeteredRequest,
	MAX_MODEL_REQUEST_BYTES,
} from "./outbound";

/** How a request to each provider's API goes out, with the workspace's key. */
const MODEL_REQUESTS: Record<EngineProvider, typeof anthropicRequest> = {
	anthropic: anthropicRequest,
	openai: openaiRequest,
	google: googleRequest,
};

/** The longest reason a refusal's span keeps, as the trace takes it. */
const MAX_REASON = 500;

/** What the Worker needs to send a request for the model: where to meter it, and to wait for that. */
export interface ModelRequestContext {
	settings: GatewaySettings;
	meter: EngineMeter;
	waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Sends the running engine's request to `provider`'s API, which `decideOutbound` allowed, once its
 * body passes `checkModelRequest`; otherwise answers it with a 403 that says why, and records the
 * refusal in the run's trace.
 */
export async function sendModelRequest(
	request: Request,
	provider: EngineProvider,
	running: RunningEngine,
	{ settings, meter, waitUntil }: ModelRequestContext,
): Promise<Response> {
	const url = new URL(request.url);
	const { meter: turn } = running.access;
	const refuse = async (reason: string, status: number) => {
		await recordRefusal(meter, turn.token, reason.slice(0, MAX_REASON), waitUntil);
		return new Response(`${reason}\n`, { status });
	};
	const outgoing = await outgoingRequest(request, provider, running, settings, url);
	if ("refused" in outgoing) return refuse(outgoing.refused, outgoing.status);
	if (outgoing instanceof Response) return outgoing;
	if (!isMeteredRequest(url)) return fetch(outgoing);
	return meterModelRequest(meter, turn.token, running.provider, () => fetch(outgoing), waitUntil);
}

/**
 * The request as it goes out, with the key and the checked body, or why it does not go: refused,
 * or a response for a setting that is wrong. The body's text stays here, not in the frame that
 * waits for the answer.
 */
async function outgoingRequest(
	request: Request,
	provider: EngineProvider,
	running: RunningEngine,
	settings: GatewaySettings,
	url: URL,
): Promise<Request | Response | { refused: string; status: number }> {
	const checked = await checkedBody(request, provider, running.model, url);
	if (!checked.ok) return { refused: checked.reason, status: checked.status };
	const { key, metadata } = running.access;
	try {
		return MODEL_REQUESTS[provider](
			new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: checked.body,
			}),
			key,
			settings,
			metadata,
		);
	} catch (error) {
		if (error instanceof SettingsError) return new Response(`${error.message}\n`, { status: 502 });
		throw error;
	}
}

type Checked = { ok: true; body: string } | { ok: false; reason: string; status: number };

/**
 * The request's body as it goes out, once `checkModelRequest` passes it, or why it does not go.
 * What goes out is what was checked, written out again: the provider then reads the same value,
 * where it might read a key the request gives twice, or text that is not UTF-8, otherwise than
 * JSON.parse does.
 *
 * Each form of the body is let go as the next is made: the text as it is parsed, the parsed value
 * once it is written out. So a request holds its text and its value at once, or its value and the
 * text that goes out, at most: about four times its size, for a body of mostly text.
 */
async function checkedBody(
	request: Request,
	provider: EngineProvider,
	model: string,
	url: URL,
): Promise<Checked> {
	const name = MODEL_PROVIDER_NAMES[provider];
	// An encoded body could not be read here, so it could hide what it asks for.
	const encoding = request.headers.get("content-encoding");
	if (encoding !== null && encoding !== "identity") {
		return {
			ok: false,
			reason: `This sandbox sends its requests to ${name} unencoded`,
			status: 403,
		};
	}
	const json = await readJson(request);
	if (json === TOO_LONG) {
		const reason = `A request to ${name} from this sandbox may be at most ${MAX_MODEL_REQUEST_BYTES / 1_000_000} MB`;
		return { ok: false, reason, status: 413 };
	}
	if (json === NOT_JSON) {
		return { ok: false, reason: `This sandbox sends ${name} only JSON`, status: 403 };
	}
	const problem = checkModelRequest(provider, model, url, json.value);
	if (problem) return { ok: false, reason: problem, status: 403 };
	return { ok: true, body: JSON.stringify(json.value) };
}

const TOO_LONG = Symbol("too long");
const NOT_JSON = Symbol("not JSON");

/** The body's JSON value; its text is let go once it is parsed. */
async function readJson(
	request: Request,
): Promise<{ value: unknown } | typeof TOO_LONG | typeof NOT_JSON> {
	const text = await readText(request, MAX_MODEL_REQUEST_BYTES);
	if (text === null) return TOO_LONG;
	try {
		return { value: JSON.parse(text) };
	} catch {
		return NOT_JSON;
	}
}

/**
 * The body as text, decoded chunk by chunk, so no chunk is kept once it is read; null when it is
 * longer than `max` bytes.
 */
async function readText(request: Request, max: number): Promise<string | null> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > max) return null;
	if (!request.body) return "";
	const decoder = new TextDecoder();
	const reader = request.body.getReader();
	let text = "";
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

/** The request's body, or null when it is longer than `max` bytes. */
export async function readAtMost(
	request: Request,
	max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > max) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > max) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	}
	const body = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.length;
	}
	return body;
}
