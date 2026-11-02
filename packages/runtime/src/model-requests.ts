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
	const { key, metadata, meter: turn } = running.access;
	const refuse = async (reason: string, status: number) => {
		await recordRefusal(meter, turn.token, reason.slice(0, MAX_REASON), waitUntil);
		return new Response(`${reason}\n`, { status });
	};
	const read = await readJson(request, provider);
	if (!read.ok) return refuse(read.reason, read.status);
	const problem = checkModelRequest(provider, running.model, url, read.json);
	if (problem) return refuse(problem, 403);
	// What was checked, written out again: the provider then reads the same value, where it might
	// read a key the request gives twice, or text that is not UTF-8, otherwise than JSON.parse does.
	const checked = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: JSON.stringify(read.json),
	});
	let outgoing: Request;
	try {
		outgoing = MODEL_REQUESTS[provider](checked, key, settings, metadata);
	} catch (error) {
		if (error instanceof SettingsError) return new Response(`${error.message}\n`, { status: 502 });
		throw error;
	}
	if (!isMeteredRequest(url)) return fetch(outgoing);
	return meterModelRequest(meter, turn.token, running.provider, () => fetch(outgoing), waitUntil);
}

type ReadBody = { ok: true; json: unknown } | { ok: false; reason: string; status: number };

/** The request's body as JSON, or why it is not one the Worker checks. */
async function readJson(request: Request, provider: EngineProvider): Promise<ReadBody> {
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
	const bytes = await readAtMost(request, MAX_MODEL_REQUEST_BYTES);
	if (bytes === null) {
		const reason = `A request to ${name} from this sandbox may be at most ${MAX_MODEL_REQUEST_BYTES / 1_000_000} MB`;
		return { ok: false, reason, status: 413 };
	}
	try {
		return { ok: true, json: JSON.parse(new TextDecoder().decode(bytes)) };
	} catch {
		return { ok: false, reason: `This sandbox sends ${name} only JSON`, status: 403 };
	}
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
