import { CHANGES_PART } from "@gateweave/agents-model";
import type { UIMessage } from "ai";
import { expect, it } from "vitest";
import { changesOf } from "./changes-part";

function messageWith(data: unknown): UIMessage {
	return {
		id: "m1",
		role: "assistant",
		parts: [
			{ type: "text", text: "Done." },
			{ type: CHANGES_PART, data } as UIMessage["parts"][number],
		],
	} as UIMessage;
}

it("reads a reply's changes", () => {
	const changes = changesOf(
		messageWith({
			truncated: false,
			files: [{ path: "src/app.ts", added: 3, deleted: 1, diff: "@@ -1 +1 @@\n-old\n+new" }],
		}),
	);
	expect(changes).toEqual({
		truncated: false,
		files: [{ path: "src/app.ts", added: 3, deleted: 1, diff: "@@ -1 +1 @@\n-old\n+new" }],
	});
});

it("answers null for a reply without the part or with one that does not read", () => {
	expect(
		changesOf({ id: "m1", role: "assistant", parts: [{ type: "text", text: "Hi" }] } as UIMessage),
	).toBeNull();
	expect(changesOf(messageWith("not an object"))).toBeNull();
	expect(changesOf(messageWith({ files: "nope" }))).toBeNull();
	expect(changesOf(messageWith({ files: [] }))).toBeNull();
});

it("skips a file that does not read and keeps the rest", () => {
	const changes = changesOf(
		messageWith({
			truncated: true,
			files: [
				{ path: "ok.ts", added: 1, deleted: 0, diff: "+x" },
				{ path: "", added: 1, deleted: 0, diff: "+x" },
				{ path: "bad.ts", added: -1, deleted: 0, diff: "+x" },
				{ path: "long.ts", added: 1, deleted: 0, diff: "x".repeat(30_000) },
			],
		}),
	);
	expect(changes?.files).toEqual([{ path: "ok.ts", added: 1, deleted: 0, diff: "+x" }]);
	expect(changes?.truncated).toBe(true);
});

it("marks the part truncated when its files pass the bound, even unflagged", () => {
	const files = Array.from({ length: 101 }, (_, index) => ({
		path: `f${index}.ts`,
		added: 1,
		deleted: 0,
		diff: "+x",
	}));
	const changes = changesOf(messageWith({ truncated: false, files }));
	expect(changes?.files).toHaveLength(100);
	expect(changes?.truncated).toBe(true);
});

it("holds the diffs to their total bound and says when it cut", () => {
	const diff = "x".repeat(20_000);
	const files = Array.from({ length: 11 }, (_, index) => ({
		path: `f${index}.ts`,
		added: 1,
		deleted: 0,
		diff,
	}));
	const changes = changesOf(messageWith({ truncated: false, files }));
	// Ten files fill the 200,000-character total; the eleventh has no room.
	expect(changes?.files).toHaveLength(10);
	expect(changes?.truncated).toBe(true);
});
