import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "../src/frontmatter";

describe("parseFrontMatter", () => {
	it("reads the block between the first two --- lines", () => {
		expect(parseFrontMatter("---\nname: a\ntags: [x, y]\n---\nBody\n")).toEqual({
			ok: true,
			data: { name: "a", tags: ["x", "y"] },
			body: "Body\n",
		});
	});

	it("handles CRLF line endings and a byte order mark", () => {
		const result = parseFrontMatter(`${String.fromCharCode(0xfeff)}---\r\nname: a\r\n---\r\nBody`);
		expect(result).toEqual({ ok: true, data: { name: "a" }, body: "Body" });
	});

	it("treats a file without front matter, or with an empty block, as having none", () => {
		expect(parseFrontMatter("# Title\n")).toEqual({ ok: true, data: {}, body: "# Title\n" });
		expect(parseFrontMatter("---\n---\nBody")).toEqual({ ok: true, data: {}, body: "Body" });
	});

	it("reports invalid YAML and non-mappings instead of throwing", () => {
		expect(parseFrontMatter("---\nname: [x\n---\n").ok).toBe(false);
		expect(parseFrontMatter("---\n- a\n- b\n---\n")).toEqual({
			ok: false,
			message: "Front matter is not a mapping",
		});
	});

	it("falls back to key: value lines when lenient", () => {
		expect(
			parseFrontMatter("---\nglobs: *.ts\nalwaysApply: true\n---\n", { lenient: true }),
		).toMatchObject({
			ok: true,
			data: { globs: "*.ts", alwaysApply: true },
		});
	});

	it("takes the blanks and the quotes off a lenient line's value", () => {
		expect(
			parseFrontMatter('---\nglobs: *.ts\na: \t b c \t \nb: "d"  \nc:\ne: \'f"\n---\n', {
				lenient: true,
			}),
		).toMatchObject({ ok: true, data: { globs: "*.ts", a: "b c", b: "d", c: "", e: "'f\"" } });
	});

	it("reads a lenient line of many blanks at once, since it can come from any repository", () => {
		const blanks = " ".repeat(200_000);
		const started = Date.now();
		const front = parseFrontMatter(`---\nglobs: *.ts${blanks}x\n---\n`, { lenient: true });

		expect(Date.now() - started).toBeLessThan(1000);
		expect(front).toMatchObject({ ok: true, data: { globs: `*.ts${blanks}x` } });
	});
});
