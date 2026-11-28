import { expect, it } from "vitest";
import { scopeAccessText } from "./oauth-consent";

it("separates task admission from run visibility in the agents:run consent text", () => {
	const text = scopeAccessText(true);

	expect(text).toContain('Starting a task needs that agent\'s "Tasks from MCP clients" setting');
	expect(text).toContain("Reading a run follows workspace membership and run visibility");
	expect(text).toContain("a member reads their own runs, and an owner or admin reads every one");
	expect(text).not.toContain("only for agents whose owner allowed tasks from outside");
});

it("calls a token without agents:run read-only", () => {
	expect(scopeAccessText(false)).toBe(" It cannot change anything.");
});
