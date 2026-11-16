import { describe, expect, it } from "vitest";
import { globMatches, readGlob } from "../src/glob";

// Each case of matching was put to ripgrep 14.1.1 (`rg --files --hidden --glob`) over the same
// paths, which agreed, but for braces in braces, which it refuses.

const PATHS = [
	".hidden/h.txt",
	"a-b/x.txt",
	"bin.dat",
	"src/B.txt",
	"src/a/crlf.txt",
	"src/a.txt",
	"src/pages/[id].tsx",
	"src/pages/index.tsx",
];

function matching(pattern: string): string[] {
	return PATHS.filter((path) => globMatches(pattern, path));
}

describe("a glob", () => {
	it("without a slash is a file's name, in any directory", () => {
		expect(matching("*.txt")).toEqual([
			".hidden/h.txt",
			"a-b/x.txt",
			"src/B.txt",
			"src/a/crlf.txt",
			"src/a.txt",
		]);
		expect(matching("?.txt")).toEqual([".hidden/h.txt", "a-b/x.txt", "src/B.txt", "src/a.txt"]);
		expect(matching("a*")).toEqual(["src/a.txt"]);
		expect(matching("bin.dat")).toEqual(["bin.dat"]);
		expect(matching("*")).toEqual(PATHS);
		expect(matching("**")).toEqual(PATHS);
	});

	it("with a slash holds from where the path starts", () => {
		expect(matching("src/*.txt")).toEqual(["src/B.txt", "src/a.txt"]);
		expect(matching("/src/*.txt")).toEqual(["src/B.txt", "src/a.txt"]);
		expect(matching("a/*.txt")).toEqual([]);
		expect(matching("/bin.dat")).toEqual(["bin.dat"]);
		expect(matching("/a.txt")).toEqual([]);
	});

	it("takes ** for any number of directories, none included", () => {
		expect(matching("**/a/*.txt")).toEqual(["src/a/crlf.txt"]);
		expect(matching("src/**")).toEqual([
			"src/B.txt",
			"src/a/crlf.txt",
			"src/a.txt",
			"src/pages/[id].tsx",
			"src/pages/index.tsx",
		]);
		expect(matching("src/**/*.txt")).toEqual(["src/B.txt", "src/a/crlf.txt", "src/a.txt"]);
		expect(matching("**/*.dat")).toEqual(["bin.dat"]);
		expect(matching("**/src/**")).toHaveLength(5);
		expect(matching("src/**/crlf.txt")).toEqual(["src/a/crlf.txt"]);
	});

	it("takes {a,b} for either, and braces in braces", () => {
		expect(matching("{a,B}.txt")).toEqual(["src/B.txt", "src/a.txt"]);
		expect(matching("src/{a,pages}/*")).toEqual([
			"src/a/crlf.txt",
			"src/pages/[id].tsx",
			"src/pages/index.tsx",
		]);
		expect(matching("{bin}.dat")).toEqual(["bin.dat"]);
		// ripgrep refuses braces in braces; here they are read.
		expect(matching("*.{txt,{dat,tsx}}")).toEqual(PATHS);
	});

	it("takes [..] for one of a set, and a backslash for the character as it is", () => {
		expect(matching("[ab].txt")).toEqual(["src/a.txt"]);
		expect(matching("[A-C].txt")).toEqual(["src/B.txt"]);
		expect(matching("[!a].txt")).toEqual([".hidden/h.txt", "a-b/x.txt", "src/B.txt"]);
		expect(matching("\\[id\\].tsx")).toEqual(["src/pages/[id].tsx"]);
		expect(matching("[id].tsx")).toEqual([]);
		expect(matching("[[]id].tsx")).toEqual(["src/pages/[id].tsx"]);
	});

	it("wants the file itself to match: a directory's name takes nothing in it", () => {
		expect(matching("src")).toEqual([]);
		expect(matching("a")).toEqual([]);
		expect(matching("src/")).toEqual([]);
		expect(matching("src/a")).toEqual([]);
	});

	it("tells capitals from small letters", () => {
		expect(matching("*.TXT")).toEqual([]);
		expect(matching("b.txt")).toEqual([]);
	});

	it("can be matched from a part of the path on", () => {
		const glob = readGlob("a/*.txt");
		if ("error" in glob) throw new Error(glob.error);
		const parts = "src/a/crlf.txt".split("/");
		expect(glob.matches(parts)).toBe(false);
		expect(glob.matches(parts, 1)).toBe(true);
	});

	it("is refused in words when it leaves files out or branches too far", () => {
		expect(readGlob("!*.md")).toEqual({
			error: "A glob that begins with ! leaves files out, which is not done here.",
		});
		expect(readGlob("{a,b}".repeat(7))).toEqual({
			error: "That glob branches into more than 64. Use fewer {…}.",
		});
		expect("error" in readGlob("{a,b}".repeat(6))).toBe(false);
	});

	it("stays quick on a glob made to be slow", () => {
		const name = `${"a".repeat(5_000)}b`;
		const started = Date.now();
		expect(globMatches(`${"*a".repeat(400)}*c`, name)).toBe(false);
		expect(globMatches(`${"**/".repeat(300)}x`, Array(300).fill("a").join("/"))).toBe(false);
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
