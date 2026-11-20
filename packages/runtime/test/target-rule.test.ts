import { describe, expect, it } from "vitest";
import { fetchedBy } from "../src/target-rule";

describe("what a page fetches from Markdown", () => {
	it("takes only plain links for links", () => {
		expect(
			fetchedBy("[docs](https://a.example) ![x](https://c.example) ![a [b] c](https://d.example)"),
		).toEqual(["https://c.example", "https://d.example"]);
	});

	it("checks a link whose text holds code, which an image could imitate", () => {
		expect(fetchedBy("[`f()`](https://b.example)")).toEqual(["https://b.example"]);
	});

	it.each(["[", "![", "](", "[a](", "[a]", "<img src=", "\\[a](", "![", "](     ", "[`a`]("])(
		"reads 200,000 characters of repeated %s within 200 ms",
		(unit) => {
			const text = unit.repeat(Math.ceil(200_000 / unit.length));
			const start = performance.now();
			fetchedBy(text);
			expect(performance.now() - start).toBeLessThan(200);
		},
	);
});
