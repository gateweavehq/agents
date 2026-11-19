/**
 * A command's output as the model reads it: its start and its end, with how much was left out
 * between them. A command can print without end, so the stream is read once and never held whole.
 */

/** Bytes of a command's output the model reads, half from the start and half from the end. */
export const OUTPUT_LIMIT = 30_000;

export interface ClippedOutput {
	text: string;
	/** Bytes left out of the middle; 0 when all of it fits. */
	omitted: number;
}

export async function clipOutput(
	stream: ReadableStream<Uint8Array> | null,
	limit = OUTPUT_LIMIT,
): Promise<ClippedOutput> {
	if (!stream) return { text: "", omitted: 0 };
	const clip = new Clip(limit);
	for await (const chunk of stream) clip.add(chunk);
	return clip.end();
}

/** Native command preview: favor the recent output, while retaining the beginning. */
export async function clipCommandOutput(
	stream: ReadableStream<Uint8Array> | null,
): Promise<ClippedOutput & { totalBytes: number }> {
	if (!stream) return { text: "", omitted: 0, totalBytes: 0 };
	const clip = new Clip(8 * 1024, 2 * 1024, true);
	let totalBytes = 0;
	for await (const chunk of stream) {
		totalBytes += chunk.byteLength;
		clip.add(chunk);
	}
	return { ...clip.end(), totalBytes };
}

/**
 * The first `limit` bytes of a stream, and how many bytes lay beyond them: for output that is
 * parsed whole, where the head-and-tail clip of `clipOutput` would tear it apart.
 */
export async function readPrefix(
	stream: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<ClippedOutput> {
	if (!stream) return { text: "", omitted: 0 };
	const chunks: Uint8Array[] = [];
	let kept = 0;
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.length;
		if (kept < limit) {
			const take = chunk.subarray(0, limit - kept);
			chunks.push(take);
			kept += take.length;
		}
	}
	const bytes = new Uint8Array(kept);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return { text: new TextDecoder().decode(bytes), omitted: total - kept };
}

/**
 * Text that is already here, clipped the same way with nothing awaited: for an answer made from
 * rows that another call could change between two awaits (`./file-store.ts`).
 */
export function clipText(chunks: Iterable<string>, limit = OUTPUT_LIMIT): ClippedOutput {
	const clip = new Clip(limit);
	const encoder = new TextEncoder();
	// Many lines to one piece, since each piece added copies the end kept so far.
	let piece = "";
	for (const chunk of chunks) {
		piece += chunk;
		if (piece.length < 16_384) continue;
		clip.add(encoder.encode(piece));
		piece = "";
	}
	if (piece !== "") clip.add(encoder.encode(piece));
	return clip.end();
}

/** The first and the last bytes of what is added, and how many lay between. */
class Clip {
	readonly #head: Uint8Array;
	readonly #tailLimit: number;
	#headLength = 0;
	#tail: Uint8Array = new Uint8Array(0);
	#total = 0;
	readonly #cleanCuts: boolean;

	constructor(limit: number, headLimit = Math.floor(limit / 2), cleanCuts = false) {
		this.#head = new Uint8Array(headLimit);
		this.#tailLimit = limit - headLimit;
		this.#cleanCuts = cleanCuts;
	}

	add(chunk: Uint8Array): void {
		this.#total += chunk.length;
		const taken = Math.min(this.#head.length - this.#headLength, chunk.length);
		this.#head.set(chunk.subarray(0, taken), this.#headLength);
		this.#headLength += taken;
		if (taken < chunk.length) {
			this.#tail = lastBytes(join(this.#tail, chunk.subarray(taken)), this.#tailLimit);
		}
	}

	end(): ClippedOutput {
		const omitted = this.#total - this.#headLength - this.#tail.length;
		const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
		if (omitted === 0) {
			return { text: decode(join(this.#head.subarray(0, this.#headLength), this.#tail)), omitted };
		}
		let head = this.#head;
		let tail = this.#tail;
		if (this.#cleanCuts) {
			// Drop UTF-8 bytes split at either crop boundary; the complete log retains them.
			head = completeUtf8Head(head);
			let start = 0;
			while (start < 3 && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
			tail = tail.subarray(start);
		}
		const leftOut = this.#total - head.length - tail.length;
		return {
			text: `${decode(head)}\n\n[${leftOut} bytes of output left out here]\n\n${decode(tail)}`,
			omitted: leftOut,
		};
	}
}

function completeUtf8Head(bytes: Uint8Array): Uint8Array {
	for (let start = bytes.length - 1; start >= Math.max(0, bytes.length - 4); start--) {
		const first = bytes[start] ?? 0;
		if (first >= 0x80 && first < 0xc0) continue;
		const width =
			first >= 0xf0 && first < 0xf8
				? 4
				: first >= 0xe0 && first < 0xf0
					? 3
					: first >= 0xc0 && first < 0xe0
						? 2
						: 1;
		return start + width > bytes.length ? bytes.subarray(0, start) : bytes;
	}
	return bytes;
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
	const joined = new Uint8Array(a.length + b.length);
	joined.set(a);
	joined.set(b, a.length);
	return joined;
}

function lastBytes(bytes: Uint8Array, length: number): Uint8Array {
	return bytes.length <= length ? bytes : bytes.slice(bytes.length - length);
}
