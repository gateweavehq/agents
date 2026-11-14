import { expect, it } from "vitest";
import { httpUrl } from "./safe-url";

it("keeps http and https addresses", () => {
	expect(httpUrl("https://track.example.com/acme/issue/ENG-7")).toBe(
		"https://track.example.com/acme/issue/ENG-7",
	);
	expect(httpUrl("http://localhost:4710/x")).toBe("http://localhost:4710/x");
});

it("refuses every other kind of address", () => {
	for (const value of [
		"javascript:alert(1)",
		" JavaScript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:x",
		"mailto:a@b.c",
		"//evil.example/x",
		"/relative",
		"not a url",
		"",
		`https://example.com/${"a".repeat(2000)}`,
	]) {
		expect(httpUrl(value), value).toBeNull();
	}
});
