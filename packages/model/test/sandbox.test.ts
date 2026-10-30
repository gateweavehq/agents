import { describe, expect, it } from "vitest";
import { sandboxOfferTo } from "../src";

describe("sandbox settings", () => {
	const binding = {};

	it("offers none without the binding, whoever is invited", () => {
		expect(sandboxOfferTo({}, "ws-1")).toBe("none");
		expect(sandboxOfferTo({ SANDBOX_WORKSPACES: "ws-1" }, "ws-1")).toBe("none");
	});

	it("offers them to every workspace when the server invites none in particular", () => {
		expect(sandboxOfferTo({ SANDBOX: binding }, "ws-1")).toBe("offered");
		expect(sandboxOfferTo({ SANDBOX: binding, SANDBOX_WORKSPACES: " , " }, "ws-1")).toBe("offered");
	});

	it("offers them only to the workspaces it names, by commas or spaces", () => {
		const settings = { SANDBOX: binding, SANDBOX_WORKSPACES: "ws-1, ws-2\nws-3" };
		for (const workspace of ["ws-1", "ws-2", "ws-3"]) {
			expect(sandboxOfferTo(settings, workspace)).toBe("offered");
		}
		expect(sandboxOfferTo(settings, "ws-4")).toBe("by-invitation");
		// A name is whole: a part of one invites nobody.
		expect(sandboxOfferTo(settings, "ws")).toBe("by-invitation");
		expect(sandboxOfferTo(settings, "")).toBe("by-invitation");
	});
});
