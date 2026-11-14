/**
 * The two server-to-server calls of connecting Track (AGT-119): trading the one-time code for the
 * agent's key and the webhook's secret, and undoing what Track made when the rest failed. Neither
 * follows a redirect, both give up after ten seconds, and the answer is read only up to a cap and
 * checked against `trackExchangeAnswer` before any of it is used. Nothing here logs or returns a
 * body: a failure is a name, since an answer can hold the key.
 */
import {
	TRACK_EXCHANGE_MAX_BYTES,
	type TrackExchangeAnswer,
	trackExchangeAnswer,
} from "@gateweave/agents-model";

export const TRACK_CALL_TIMEOUT_MS = 10_000;

/** What went wrong with the exchange, in words the person can act on. */
export type ExchangeFailure = "refused" | "busy" | "unreachable" | "unexpected";

export type Exchange =
	| { ok: true; answer: TrackExchangeAnswer }
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
export async function exchangeCode(
	trackOrigin: string,
	code: string,
	verifier: string,
	fetcher: typeof fetch = fetch,
): Promise<Exchange> {
	const answered = await post(trackOrigin, "/api/connect/exchange", { code, verifier }, fetcher);
	if (!answered) return { ok: false, why: "unreachable" };
	if (answered.status === 429) return { ok: false, why: "busy" };
	if (answered.status === 400 && errorOf(answered.text) === "invalid_code") {
		return { ok: false, why: "refused" };
	}
	if (answered.status !== 200 || answered.text === null) return { ok: false, why: "unexpected" };
	let json: unknown;
	try {
		json = JSON.parse(answered.text);
	} catch {
		return { ok: false, why: "unexpected" };
	}
	const parsed = trackExchangeAnswer.safeParse(json);
	if (parsed.success) return { ok: true, answer: parsed.data };
	const undo = (json as { undo?: unknown } | null)?.undo;
	return {
		ok: false,
		why: "unexpected",
		...(typeof undo === "string" && undo.length > 0 && undo.length <= 4096 ? { undo } : {}),
	};
}

/**
 * Asks Track to remove the agent member and the webhook it made. A 500 `try_again`, a timeout and
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
