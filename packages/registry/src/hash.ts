// node:crypto hashes synchronously, so hashing can happen inside a write transaction.
import { createHash } from "node:crypto";
import type { FileEntry } from "./db/schema";

/** Git's id for a file with these bytes, as `git hash-object` computes it. */
export function gitBlobId(bytes: Uint8Array): string {
	return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/**
 * The hash of an asset's content: its files' paths and blob ids, in path order. Paths cannot
 * contain NUL and blob ids have a fixed length, so no two file lists produce the same input.
 */
export function assetHash(files: readonly FileEntry[]): string {
	const hash = createHash("sha256");
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	for (const file of sorted) hash.update(`${file.path}\0${file.blob}\n`);
	return hash.digest("hex");
}
