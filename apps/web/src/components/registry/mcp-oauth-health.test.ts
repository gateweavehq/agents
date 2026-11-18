import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { McpOAuthStatus } from "./mcp-oauth-health";

it("uses the same connection words for MCP, agent and team pages", () => {
	const shown = (state: Parameters<typeof McpOAuthStatus>[0]["state"]) =>
		renderToStaticMarkup(createElement(McpOAuthStatus, { state }));
	expect(shown("connected")).toContain("Connected");
	expect(shown("needs-reconnecting")).toContain("Needs reconnecting");
	expect(shown("could-not-check")).toContain("Could not check");
	expect(shown("checking")).toContain("Checking connection");
	const checked = renderToStaticMarkup(
		createElement(McpOAuthStatus, {
			state: "could-not-check",
			checkedAt: 1_700_000_000_000,
			reason: "HTTP 403",
		}),
	);
	expect(checked).toContain("HTTP 403");
	expect(checked).toContain("last checked");
});
