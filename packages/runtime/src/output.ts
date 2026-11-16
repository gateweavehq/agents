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

	constructor(limit: number) {
		const headLimit = Math.floor(limit / 2);
		this.#head = new Uint8Array(headLimit);
		this.#tailLimit = limit - headLimit;
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
		return {
			text: `${decode(this.#head)}\n\n[${omitted} bytes of output left out here]\n\n${decode(this.#tail)}`,
			omitted,
		};
	}
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
