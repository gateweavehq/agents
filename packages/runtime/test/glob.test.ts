import { describe, expect, it } from "vitest";
import { GlobTooSlow, globMatches, readGlob } from "../src/glob";

// Each case of matching was put to ripgrep 14.1.1 (`rg --files --hidden --glob`) over the same
// paths by hand, which agreed, but for braces in braces, which it refuses. What is held to
// ripgrep by a test is in `ripgrep-recorded.test.ts`: the sandbox image's own, recorded.

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

	it("takes ? and a set for one character, one outside the first plane included", () => {
		expect(globMatches("?.txt", "😀.txt")).toBe(true);
		expect(globMatches("??.txt", "😀.txt")).toBe(false);
		expect(globMatches("a?b", "a😀b")).toBe(true);
		expect(globMatches("[😀-😂].txt", "😁.txt")).toBe(true);
		expect(globMatches("[😀-😂].txt", "😃.txt")).toBe(false);
		expect(globMatches("[!😀].txt", "😁.txt")).toBe(true);
		expect(globMatches("😀*", "😀😁.txt")).toBe(true);
	});

	it("takes ** parts in a row for one, and refuses more parts than it will match", () => {
		expect(globMatches(`${"**/".repeat(320)}x.txt`, "a/b/c/x.txt")).toBe(true);
		expect(readGlob(`${"**/a/".repeat(9)}x`)).toEqual({
			error: "That glob has more than 8 parts that are **.",
		});
		expect("error" in readGlob(`${"**/a/".repeat(8)}x`)).toBe(false);
		expect(readGlob(`${"a/".repeat(64)}x`)).toEqual({
			error: "That glob has more than 64 parts between its slashes.",
		});
		expect("error" in readGlob(`${"a/".repeat(63)}x`)).toBe(false);
	});

	/** The clock here stands still while code runs, and moves on at the next timer. */
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	/** As many paths as a repository may hold, each twelve parts deep and made to match slowly. */
	const deep = Array.from({ length: 20_000 }, (_, index) => [
		...Array.from({ length: 11 }, () => "a".repeat(24)),
		`file-${index}.txt`,
	]);

	it("stops a glob made to be slow, within a second or so, over 20,000 paths", async () => {
		// Sixty-four branches, eight `**` in each, and parts that go back over every `a`.
		const slow = readGlob(`${"**/*a*a*a*a*b/".repeat(8)}${"{x,y}".repeat(6)}`);
		if ("error" in slow) throw new Error(slow.error);
		await tick();
		const started = Date.now();
		let matched = 0;
		const stopped = (() => {
			try {
				for (const parts of deep) if (slow.matches(parts)) matched++;
				return null;
			} catch (error) {
				return error;
			}
		})();
		await tick();
		expect(stopped).toBeInstanceOf(GlobTooSlow);
		expect((stopped as Error).message).toBe(
			"That glob takes too long to match against these files. Use a simpler one.",
		);
		expect(matched).toBe(0);
		expect(Date.now() - started).toBeLessThan(3_000);
		// Once stopped it stays stopped: the steps are the glob's, not each call's.
		expect(() => slow.matches(deep[0] ?? [])).toThrow(GlobTooSlow);

		// One part that goes back over a long name is bounded the same way.
		const name = [`${"a".repeat(5_000)}b`];
		const part = readGlob(`${"*a".repeat(400)}*c`, 1_000);
		if ("error" in part) throw new Error(part.error);
		expect(() => part.matches(name)).toThrow(GlobTooSlow);
	});

	it("matches the globs people write over 20,000 paths without being stopped", async () => {
		await tick();
		const started = Date.now();
		const count = (pattern: string, from = 0) => {
			const glob = readGlob(pattern);
			if ("error" in glob) throw new Error(glob.error);
			return deep.filter((parts) => glob.matches(parts, from)).length;
		};
		expect(count("*.txt")).toBe(20_000);
		expect(count("**/*.txt")).toBe(20_000);
		expect(count("*.{ts,tsx,js,jsx,mjs,cjs,json,md,txt}")).toBe(20_000);
		expect(count("**/file-1999?.txt")).toBe(10);
		expect(count(`${"a".repeat(24)}/**/*.txt`)).toBe(20_000);
		expect(count("src/**/*.ts")).toBe(0);
		expect(count("*.rs")).toBe(0);
		await tick();
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
