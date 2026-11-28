/**
 * The two server-to-server calls of connecting Track: trading the one-time code for the
 * credentials and undoing what Track made when the rest failed. Neither follows a redirect, both
 * give up after ten seconds, and the answer is size-capped and checked against the approval's
 * schema before any of it is used. Nothing here logs or returns a
 * body: a failure is a name, since an answer can hold the key.
 */
import {
	TRACK_EXCHANGE_MAX_BYTES,
	trackExchangeAnswer,
	trackSourceAnswer,
	trackSourceUndo,
} from "@gateweave/agents-model";
import type { ZodType } from "zod";

export const TRACK_CALL_TIMEOUT_MS = 10_000;

/** What went wrong with the exchange, in words the person can act on. */
export type ExchangeFailure = "refused" | "busy" | "unreachable" | "unexpected";

type Exchange<Answer> =
	| { ok: true; answer: Answer }
	/** `undo` is the token of an answer that could not be used but may have made things. */
	| { ok: false; why: ExchangeFailure; undo?: string };

/** The body as text, or null when it is longer than `max` bytes. The rest is never read. */
export async function readCapped(response: Response, max: number): Promise<string | null> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function post(
	trackOrigin: string,
	path: string,
	body: Record<string, string>,
	fetcher: typeof fetch,
): Promise<{ status: number; text: string | null } | null> {
	try {
		const response = await fetcher(`${trackOrigin}${path}`, {
			method: "POST",
			// A redirect is a failure: the code and the verifier go to the address the person chose.
			redirect: "manual",
			signal: AbortSignal.timeout(TRACK_CALL_TIMEOUT_MS),
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(body),
		});
		return { status: response.status, text: await readCapped(response, TRACK_EXCHANGE_MAX_BYTES) };
	} catch {
		return null;
	}
}

function errorOf(text: string | null): string | null {
	try {
		const found: unknown = JSON.parse(text ?? "");
		const error = (found as { error?: unknown } | null)?.error;
		return typeof error === "string" ? error : null;
	} catch {
		return null;
	}
}

/** Trades the code, with the verifier that proves this server started the flow. */
export function exchangeCode(trackOrigin: string, code: string, verifier: string, fetcher = fetch) {
	return exchange(trackOrigin, code, verifier, fetcher, trackExchangeAnswer);
}

export function exchangeSourceCode(
	trackOrigin: string,
	code: string,
	verifier: string,
	fetcher = fetch,
) {
	return exchange(trackOrigin, code, verifier, fetcher, trackSourceAnswer(trackOrigin), true);
}

async function exchange<Answer>(
	trackOrigin: string,
	code: string,
	verifier: string,
	fetcher: typeof fetch,
	schema: ZodType<Answer>,
	source = false,
): Promise<Exchange<Answer>> {
	const answered = await post(trackOrigin, "/api/connect/exchange", { code, verifier }, fetcher);
	if (!answered) return { ok: false, why: "unreachable" };
	const { status, text } = answered;
	const why =
		status === 429
			? "busy"
			: status === 400 && errorOf(text) === "invalid_code"
				? "refused"
				: "unexpected";
	if ((!source && status !== 200) || text === null) return { ok: false, why };
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { ok: false, why };
	}
	if (status === 200) {
		const parsed = schema.safeParse(json);
		if (parsed.success) return { ok: true, answer: parsed.data };
	}
	const undo = (json as { undo?: unknown } | null)?.undo;
	if (source) {
		const token = trackSourceUndo.safeParse(undo);
		return token.success ? { ok: false, why, undo: token.data } : { ok: false, why };
	}
	return {
		ok: false,
		why,
		...(typeof undo === "string" && undo.length > 0 && undo.length <= 4096 ? { undo } : {}),
	};
}

/**
 * Asks Track to remove what it created for the approval. A 500 `try_again`, a timeout and
 * an unreachable Track are tried again, three times in all, with short waits. True once Track
 * said it is done.
 */
export async function undoConnection(
	trackOrigin: string,
	undo: string,
	{
		fetcher = fetch,
		wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}: { fetcher?: typeof fetch; wait?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const answered = await post(trackOrigin, "/api/connect/undo", { undo }, fetcher);
		if (answered?.status === 200) return true;
		// Anything but a try-again answer will not change by asking again.
		if (answered && !(answered.status === 500 && errorOf(answered.text) === "try_again")) {
			return false;
		}
		if (attempt < 3) await wait(attempt * 400);
	}
	return false;
}
