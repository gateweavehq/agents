import type { AssetFile } from "@gateweave/agents-model";
import { expect, it } from "vitest";
import { diffFiles } from "./version-diff";

const file = (path: string, content: string | null): AssetFile => ({
	path,
	// Not a real Git id; equal text must give an equal one, which is all the diff relies on.
	blob: (content ?? "binary").padEnd(40, "."),
	size: content?.length ?? 0,
	content,
});

it("lists added, removed and changed files, and leaves the same ones out", () => {
	const diffs = diffFiles(
		[file("a.md", "one\ntwo\n"), file("gone.md", "x\n"), file("same.md", "s\n")],
		[file("a.md", "one\n2\nthree\n"), file("new.md", "n\n"), file("same.md", "s\n")],
	);
	expect(diffs.map((d) => [d.path, d.status])).toEqual([
		["a.md", "changed"],
		["gone.md", "removed"],
		["new.md", "added"],
	]);
	expect(diffs[0]?.lines?.map((l) => `${l.kind}${l.text}`)).toEqual([
		" one",
		"-two",
		"+2",
		"+three",
	]);
	expect(diffs[1]?.lines).toEqual([{ kind: "-", text: "x" }]);
	expect(diffs[2]?.lines).toEqual([{ kind: "+", text: "n" }]);
});

it("says so when a file's text is not kept instead of comparing it", () => {
	const [only] = diffFiles(
		[file("big.bin", null)],
		[{ ...file("big.bin", null), blob: "changed".padEnd(40, ".") }],
	);
	expect(only).toMatchObject({ path: "big.bin", status: "changed", lines: null });
});

it("marks a change in the final newline", () => {
	const [only] = diffFiles([file("a.md", "x\n")], [file("a.md", "x")]);
	expect(only?.status).toBe("changed");
	expect(only?.lines?.length).toBeGreaterThan(0);
});
