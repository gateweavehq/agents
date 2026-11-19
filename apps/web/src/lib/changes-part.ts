import { CHANGES_PART, type ChangesFile, type ChangesPartData } from "@gateweave/agents-model";
import type { UIMessage } from "ai";

/**
 * Bounds the chat trusts in a stored part again: the server caps a turn's changes (`./changes.ts`
 * in the runtime), and a part read back is checked the same way before it is drawn.
 */
const MAX_FILES = 100;
const MAX_FILE_DIFF = 20_000;
const MAX_PATH = 1_000;

/**
 * What a reply's changes part carries, or null when it has none: replies from before the part
 * existed carry nothing, and a part that does not read as one is skipped.
 */
export function changesOf(message: UIMessage): ChangesPartData | null {
	for (const part of message.parts) {
		if (part.type !== CHANGES_PART) continue;
		const data = (part as { data?: unknown }).data;
		const changes = readChanges(data);
		if (changes !== null) return changes;
	}
	return null;
}

function readChanges(data: unknown): ChangesPartData | null {
	if (typeof data !== "object" || data === null) return null;
	const { files, truncated } = data as { files?: unknown; truncated?: unknown };
	if (!Array.isArray(files)) return null;
	const read: ChangesFile[] = [];
	for (const file of files.slice(0, MAX_FILES)) {
		const each = readFile(file);
		if (each !== null) read.push(each);
	}
	if (read.length === 0) return null;
	return { files: read, truncated: truncated === true };
}

function readFile(file: unknown): ChangesFile | null {
	if (typeof file !== "object" || file === null) return null;
	const { path, added, deleted, diff } = file as Record<string, unknown>;
	if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH) return null;
	if (typeof added !== "number" || !Number.isFinite(added) || added < 0) return null;
	if (typeof deleted !== "number" || !Number.isFinite(deleted) || deleted < 0) return null;
	if (typeof diff !== "string" || diff.length > MAX_FILE_DIFF) return null;
	return { path, added, deleted, diff };
}
