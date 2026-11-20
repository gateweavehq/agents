import { describe, expect, it } from "vitest";
import {
	forgetKept,
	KEPT_KEYS,
	type KeptStorage,
	markForgotten,
	OPENCODE_SESSION_KEY,
	PUSHED_KEY,
	REPOSITORY_KEY,
	readKept,
	replaceKept,
	SESSION_KEY,
} from "../src/kept-keys";

/** A stand-in for the Durable Object's `storage.kv`. */
function memory(): KeptStorage & { entries: Map<string, unknown> } {
	const entries = new Map<string, unknown>();
	return {
		entries,
		get: (key) => entries.get(key),
		put: (key, value) => void entries.set(key, value),
		delete: (key) => void entries.delete(key),
	};
}

describe("what a sandbox keeps of its conversation", () => {
	it("reads only the kept keys that are set, for a move to carry along", () => {
		const storage = memory();
		storage.put(REPOSITORY_KEY, { owner: "acme" });
		storage.put("other", "not kept");
		expect(readKept(storage)).toEqual([[REPOSITORY_KEY, { owner: "acme" }]]);
	});

	it("replaces the kept keys with a move's entries, and nothing else", () => {
		const storage = memory();
		storage.put(REPOSITORY_KEY, { owner: "old" });
		storage.put(SESSION_KEY, "old-session");
		storage.put("other", "untouched");
		replaceKept(storage, [
			[PUSHED_KEY, "abc123"],
			["not-a-kept-key", "dropped"],
		]);
		expect(readKept(storage)).toEqual([[PUSHED_KEY, "abc123"]]);
		expect(storage.get("other")).toBe("untouched");
	});

	it("forgets the kept keys only once the conversation was marked as being erased", () => {
		const storage = memory();
		storage.put(REPOSITORY_KEY, { owner: "acme" });
		storage.put(PUSHED_KEY, "abc123");
		storage.put(SESSION_KEY, "claude-session");
		storage.put(OPENCODE_SESSION_KEY, "opencode-session");
		storage.put("other", "untouched");

		// A caller that reaches the sandbox directly wipes nothing of a live conversation.
		expect(() => forgetKept(storage)).toThrow("being erased");
		expect(readKept(storage)).toHaveLength(KEPT_KEYS.length);

		markForgotten(storage);
		forgetKept(storage);
		expect(readKept(storage)).toEqual([]);
		expect(storage.get("other")).toBe("untouched");
	});

	it("keeps the mark out of what a move carries", () => {
		const storage = memory();
		markForgotten(storage);
		storage.put(REPOSITORY_KEY, { owner: "acme" });
		// The mark is not one of KEPT_KEYS, so a move never brings it to the new sandbox.
		expect(readKept(storage)).toEqual([[REPOSITORY_KEY, { owner: "acme" }]]);
		replaceKept(storage, readKept(storage));
		expect(storage.get("sandbox.forgotten")).toBe(true);
	});
});
