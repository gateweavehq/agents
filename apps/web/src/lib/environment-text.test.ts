import { describe, expect, it } from "vitest";
import { formatVariables, parseSecretNames, parseVariables } from "./environment-text";

describe("parseVariables", () => {
	it("reads NAME=value lines, keeping everything after the first equals sign", () => {
		expect(parseVariables("A=1\n\n# a comment\nURL=https://x.test/?a=b\r\nEMPTY=\n")).toEqual({
			ok: true,
			variables: { A: "1", URL: "https://x.test/?a=b", EMPTY: "" },
		});
	});

	it("says which line is wrong", () => {
		expect(parseVariables("A=1\nnope")).toEqual({ ok: false, error: "Line 2: write NAME=value" });
		expect(parseVariables("=x")).toMatchObject({ ok: false });
		expect(parseVariables("lower=x")).toMatchObject({
			ok: false,
			error: expect.stringContaining("Line 1"),
		});
		expect(parseVariables("A=1\nA=2")).toEqual({ ok: false, error: "Line 2: A appears twice" });
	});

	it("round-trips with formatVariables", () => {
		const variables = { LOG_LEVEL: "info", A_B: "x y" };
		expect(parseVariables(formatVariables(variables))).toEqual({ ok: true, variables });
	});
});

describe("parseSecretNames", () => {
	it("splits on lines, commas and spaces, once per name", () => {
		expect(parseSecretNames("A, B\nC  A\n")).toEqual(["A", "B", "C"]);
		expect(parseSecretNames("")).toEqual([]);
	});
});
