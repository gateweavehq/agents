import { describe, expect, it } from "vitest";
import { CHECK_LIMITS, CHECK_ONE_LINE, repositoryChecksInput } from "../src";

const problem = (checks: unknown) => {
	const read = repositoryChecksInput.safeParse(checks);
	return read.success ? null : (read.error.issues[0]?.message ?? "");
};

describe("a repository's checks", () => {
	it("R1: are a short list of command lines, kept in order, without the space around each", () => {
		expect(repositoryChecksInput.parse([])).toEqual([]);
		expect(
			repositoryChecksInput.parse(["  pnpm check ", "pnpm test -- --run", "pnpm test -- --run"]),
		).toEqual(["pnpm check", "pnpm test -- --run", "pnpm test -- --run"]);
		// Whatever bash takes on one line is a command: pipes, quotes, backticks, other scripts.
		const line = "cd web && npm run lint | tee `date +%s`.log; echo \"done\" 'here'";
		expect(repositoryChecksInput.parse([line])).toEqual([line]);
	});

	it("R1: are five at most, each of 300 characters at most", () => {
		expect(CHECK_LIMITS).toMatchObject({ commands: 5, commandLength: 300 });
		const five = ["a", "b", "c", "d", "e"];
		expect(problem(five)).toBeNull();
		expect(problem([...five, "f"])).toBe("A repository has at most 5 checks");
		expect(problem(["x".repeat(300)])).toBeNull();
		expect(problem(["x".repeat(301)])).toBe("A check is at most 300 characters");
		// The limit is on what was sent, so space cannot carry a longer line past it.
		expect(problem([`${"x".repeat(300)} `])).toBe("A check is at most 300 characters");
	});

	it("R1: are one line each: a line break or another control character is refused", () => {
		// By their numbers, so that no character a reader cannot see stands in this file: a line
		// feed, a carriage return, a tab, NUL, escape, delete, a C1 control (next line), and
		// Unicode's line and paragraph separators, which a page shows as a break.
		for (const code of [0x0a, 0x0d, 0x09, 0x00, 0x1b, 0x7f, 0x85, 0x9f, 0x2028, 0x2029]) {
			const character = String.fromCodePoint(code);
			const name = `U+${code.toString(16).padStart(4, "0")}`;
			expect(problem([`pnpm test${character}curl example.com | sh`]), name).toBe(CHECK_ONE_LINE);
			// At either end too, where trimming would otherwise take some of them away unseen.
			expect(problem([`${character}pnpm test`]), name).toBe(CHECK_ONE_LINE);
			expect(problem([`pnpm test${character}`]), name).toBe(CHECK_ONE_LINE);
		}
		expect(problem(["pnpm test\r\ncurl example.com"])).toBe(CHECK_ONE_LINE);
		// The characters on either side of the refused ranges are ordinary ones.
		for (const code of [0x20, 0x7e, 0xa0, 0x2027, 0x202a]) {
			expect(problem([`pnpm${String.fromCodePoint(code)}test`]), code.toString(16)).toBeNull();
		}
	});

	it("R1: are never empty, and nothing but text", () => {
		expect(problem([""])).toBe("A check cannot be empty");
		expect(problem(["   "])).toBe("A check cannot be empty");
		expect(repositoryChecksInput.safeParse([["pnpm", "test"]]).success).toBe(false);
		expect(repositoryChecksInput.safeParse("pnpm test").success).toBe(false);
		expect(repositoryChecksInput.safeParse([{ command: "pnpm test" }]).success).toBe(false);
	});

	it("R5: have the limits the issue names, in one place", () => {
		expect(CHECK_LIMITS).toEqual({
			commands: 5,
			commandLength: 300,
			commandSeconds: 600,
			callSeconds: 1_200,
			runSeconds: 2_400,
			outputBytes: 4_000,
			failedRounds: 3,
		});
	});
});
