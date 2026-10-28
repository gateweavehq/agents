import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const render = (text: string) => renderToString(createElement(Markdown, null, text));

describe("Markdown", () => {
	it("shows a script tag as text instead of making an element", () => {
		const html = render("hello <script>alert(1)</script> world");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;");
	});

	it("shows an img with an event handler as text", () => {
		const html = render('<img src=x onerror="alert(1)">');
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("drops the href of a javascript: link", () => {
		const html = render("[click](javascript:alert(1))");
		expect(html).not.toContain("javascript:");
		expect(html).toContain("click");
	});

	it("opens links in a new tab without leaking the opener", () => {
		const html = render("[docs](https://example.com/a)");
		expect(html).toContain('href="https://example.com/a"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer nofollow"');
	});

	it("renders a fenced code block with a copy button, and inline code", () => {
		const html = render("Use `pnpm test`.\n\n```ts\nconst a = 1;\n```");
		expect(html).toContain("<pre");
		expect(html).toContain("const a = 1;");
		expect(html).toContain('aria-label="Copy code"');
		expect(html).toContain("<code");
		expect(html).toContain("pnpm test");
	});

	it("renders a GFM table", () => {
		const html = render("| a | b |\n| - | - |\n| 1 | 2 |");
		expect(html).toContain("<table");
		expect(html).toContain("<th");
		expect(html).toContain("<td");
	});

	it("renders headings, lists, emphasis and blockquotes", () => {
		const html = render("# Title\n\n- one\n- two\n\n**bold** and *em*\n\n> quoted");
		expect(html).toContain("<h1");
		expect(html).toContain("<ul");
		expect(html).toContain("<li");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>em</em>");
		expect(html).toContain("<blockquote");
	});
});
