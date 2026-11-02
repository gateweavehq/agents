import { describe, expect, it } from "vitest";
import { invitationLink } from "./invitation";

const workspace = { id: "ws-123", name: "Acme Labs" };

describe("invitationLink", () => {
	it("writes an email that names the workspace and its id", () => {
		const link = invitationLink(" owner@example.com ", workspace);
		expect(link?.startsWith("mailto:owner@example.com?")).toBe(true);
		const query = new URLSearchParams(link?.split("?")[1]);
		expect(query.get("subject")).toBe("Invitation for Acme Labs");
		expect(query.get("body")).toContain("Acme Labs (ws-123)");
		expect(link).not.toContain("+");
	});

	it("keeps an https link as it is, and refuses anything else", () => {
		expect(invitationLink("https://gateweave.com/contact", workspace)).toBe(
			"https://gateweave.com/contact",
		);
		expect(invitationLink(undefined, workspace)).toBeNull();
		expect(invitationLink("", workspace)).toBeNull();
		expect(invitationLink("javascript:alert(1)", workspace)).toBeNull();
		expect(invitationLink("http://insecure.example", workspace)).toBeNull();
		expect(invitationLink("a@b.c?cc=evil@example.com", workspace)).toBeNull();
	});
});
