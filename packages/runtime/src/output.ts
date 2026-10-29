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
	const headLimit = Math.floor(limit / 2);
	const tailLimit = limit - headLimit;
	const head = new Uint8Array(headLimit);
	let headLength = 0;
	let tail: Uint8Array = new Uint8Array(0);
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.length;
		const taken = Math.min(headLimit - headLength, chunk.length);
		head.set(chunk.subarray(0, taken), headLength);
		headLength += taken;
		if (taken < chunk.length) tail = lastBytes(join(tail, chunk.subarray(taken)), tailLimit);
	}
	const omitted = total - headLength - tail.length;
	const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
	if (omitted === 0) return { text: decode(join(head.subarray(0, headLength), tail)), omitted };
	return {
		text: `${decode(head)}\n\n[${omitted} bytes of output left out here]\n\n${decode(tail)}`,
		omitted,
	};
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
