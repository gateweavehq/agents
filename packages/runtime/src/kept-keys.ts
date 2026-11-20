/**
 * What a conversation's sandbox keeps of it between turns: the repository it cloned and what it
 * pushed, and the CLIs' sessions. A workspace move carries these to the sandbox of the same name
 * where it goes (`moveKeys`/`takeKeys` in `sandbox.ts`), and deleting the conversation erases them
 * with it. None of it is ever in a move's copy of the conversation itself.
 *
 * The sandbox wipes them only through `forgetKept`, which asks for the mark its conversation left
 * when it was erased (`markForgotten`): a caller that reaches the sandbox directly cannot wipe a
 * live conversation's keys by mistake (AGT-156).
 */

/** The repository the sandbox cloned for its conversation. */
export const REPOSITORY_KEY = "repository";
/** The commit the conversation last pushed to its branch. */
export const PUSHED_KEY = "pushed";
/** The conversation's Claude Code session, which its turns resume while the container has it. */
export const SESSION_KEY = "claude-code-session";
/** The conversation's OpenCode session, which its turns continue while the container has it. */
export const OPENCODE_SESSION_KEY = "opencode-session";

/** What a sandbox keeps of its conversation, which goes with it when its workspace moves. */
export const KEPT_KEYS: readonly string[] = [
	REPOSITORY_KEY,
	PUSHED_KEY,
	SESSION_KEY,
	OPENCODE_SESSION_KEY,
];

/**
 * The sandbox's own mark that its conversation is being erased. Written only through the
 * conversation (`markForForget` in `sandbox.ts`), never carried by a move, and what lets
 * `forgetKept` wipe the kept keys.
 */
export const FORGOTTEN_KEY = "sandbox.forgotten";

/** The least a key-value needs: the Durable Object's `storage.kv`, or a Map in a test. */
export interface KeptStorage {
	get(key: string): unknown;
	put(key: string, value: unknown): void;
	delete(key: string): void;
}

/** What the sandbox keeps of its conversation, for a move to take along. */
export function readKept(storage: KeptStorage): [string, unknown][] {
	return KEPT_KEYS.flatMap((key) => {
		const value = storage.get(key);
		return value === undefined ? [] : [[key, value] as [string, unknown]];
	});
}

/**
 * Replaces what the sandbox keeps with `entries`, which are the old sandbox's `readKept` of a
 * move: anything kept before goes, and only keys `KEPT_KEYS` names are taken.
 */
export function replaceKept(storage: KeptStorage, entries: [string, unknown][]): void {
	for (const key of KEPT_KEYS) storage.delete(key);
	for (const [key, value] of entries) if (KEPT_KEYS.includes(key)) storage.put(key, value);
}

/** Marks the sandbox as being erased with its conversation, so `forgetKept` may wipe it. */
export function markForgotten(storage: KeptStorage): void {
	storage.put(FORGOTTEN_KEY, true);
}

/**
 * Throws unless the conversation was marked as being erased, so a live conversation's sandbox
 * refuses a forget before anything of it is stopped or wiped.
 */
export function assertForgotten(storage: KeptStorage): void {
	if (storage.get(FORGOTTEN_KEY) === undefined) {
		throw new Error("Only a conversation being erased can forget its sandbox's kept keys.");
	}
}

/**
 * Wipes what the sandbox keeps of its conversation. Throws unless the conversation was marked as
 * being erased first, so a live conversation's keys survive a caller that forgets by mistake.
 */
export function forgetKept(storage: KeptStorage): void {
	assertForgotten(storage);
	for (const key of KEPT_KEYS) storage.delete(key);
	// The mark has done its work: the sandbox is empty, and nothing may forget it again by it.
	storage.delete(FORGOTTEN_KEY);
}
