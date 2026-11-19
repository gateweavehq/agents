import { expect, it } from "vitest";
import { isAdmin } from "./roles";

it.each([
	["owner", true],
	["admin", true],
	["member", false],
	["unexpected", false],
])("returns %s's workspace admin status as %s", (role, expected) => {
	expect(isAdmin(role)).toBe(expected);
});
