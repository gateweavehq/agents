import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { healthRequestKey, McpOAuthStatus } from "./mcp-oauth-health";

it("changes the health request key when a pinned OAuth server is added", () => {
	const before = healthRequestKey("workspace", ["agent"], ["server-one"]);
	const after = healthRequestKey("workspace", ["agent"], ["server-one", "server-two"]);
	expect(after).not.toBe(before);
});

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
