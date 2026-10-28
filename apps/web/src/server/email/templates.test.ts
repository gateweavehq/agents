import { describe, expect, it } from "vitest";
import { invitationEmail, passwordResetEmail, verificationEmail } from "./templates";

const DAY = 24 * 60 * 60 * 1000;

describe("invitationEmail", () => {
	const now = Date.UTC(2026, 9, 28);
	const base = {
		inviter: { name: "Maya Chen", email: "maya@example.com" },
		workspace: "Acme",
		url: "https://agents.example.com/invite/abc?x=1&y=2",
		expiresAt: now + 7 * DAY,
		now,
	};

	it("says who invited whom to what, and links to the invitation", () => {
		const email = invitationEmail(base);
		expect(email.subject).toBe("Maya Chen invited you to Acme on Gateweave Agents");
		expect(email.text).toContain("Maya Chen (maya@example.com)");
		expect(email.text).toContain(base.url);
		expect(email.text).toContain("expires in 7 days");
		expect(email.html).toContain('href="https://agents.example.com/invite/abc?x=1&amp;y=2"');
	});

	it("escapes names in HTML and keeps them to one short line", () => {
		const email = invitationEmail({
			...base,
			inviter: { name: "Mallory\r\nBcc: everyone", email: "m@example.com" },
			workspace: `<img src=x onerror=alert(1)> ${"very ".repeat(30)}long`,
		});
		expect(email.subject).not.toMatch(/[\r\n]/);
		expect(email.subject).toContain("Mallory Bcc: everyone invited you to");
		expect(email.subject).toContain("…");
		expect(email.html).not.toContain("<img");
		expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("counts down to a day, never zero", () => {
		const email = invitationEmail({ ...base, expiresAt: now + 3 * 60 * 60 * 1000 });
		expect(email.text).toContain("expires in 1 day.");
	});
});

describe("passwordResetEmail", () => {
	it("links to the reset and says what happens", () => {
		const url = "https://agents.example.com/api/auth/reset-password/token?callbackURL=%2Freset";
		const email = passwordResetEmail({ url });
		expect(email.subject).toBe("Reset your Gateweave Agents password");
		expect(email.text).toContain(url);
		expect(email.text).toContain("signs you out on every device");
		expect(email.html).toContain(`href="${url}"`);
	});
});

describe("verificationEmail", () => {
	it("links to the verification and says how long it works", () => {
		const url = "https://agents.example.com/api/auth/verify-email?token=t&callbackURL=%2F";
		const email = verificationEmail({ url });
		expect(email.subject).toBe("Verify your email for Gateweave Agents");
		expect(email.text).toContain(url);
		expect(email.text).toContain("24 hours");
		expect(email.html).toContain(`href="${url.replace("&", "&amp;")}"`);
	});
});
