import { describe, expect, it } from "vitest";
import { auditRecordOf, isAuditedPath } from "./audit";

describe("audit records from Better Auth's answers", () => {
	it("follows only the paths that change who belongs to a workspace, or the workspace", () => {
		expect(isAuditedPath("/organization/invite-member")).toBe(true);
		expect(isAuditedPath("/organization/update")).toBe(true);
		expect(isAuditedPath("/organization/list-invitations")).toBe(false);
		expect(isAuditedPath("/sign-in/email")).toBe(false);
		expect(isAuditedPath("toString")).toBe(false);
		expect(isAuditedPath(undefined)).toBe(false);
	});

	it("names whoever joined as the member it was done to", () => {
		const answer = {
			invitation: { id: "inv-1", organizationId: "ws-1" },
			member: { id: "m-1", userId: "user-joe", organizationId: "ws-1", role: "member" },
		};
		expect(auditRecordOf("/organization/accept-invitation", answer)).toEqual({
			workspaceId: "ws-1",
			record: {
				action: "member.joined",
				target: { type: "member", id: "user-joe", label: null },
				detail: { role: "member" },
			},
		});
	});

	it("keeps an invited address in lower case, and says when it went again", () => {
		const answer = { id: "inv-1", email: "Bo@Example.COM", role: "admin", organizationId: "ws-1" };
		expect(
			auditRecordOf("/organization/invite-member", answer, {
				body: { email: "Bo@Example.COM", role: "admin", resend: true },
			})?.record,
		).toEqual({
			action: "invitation.created",
			target: { type: "invitation", id: "inv-1", label: "bo@example.com" },
			detail: { role: "admin", resent: true },
		});
	});

	it("records nothing for an error, or for a role or name that stayed the same", () => {
		expect(
			auditRecordOf("/organization/remove-member", { message: "Member not found" }),
		).toBeNull();
		const role = { userId: "user-mo", organizationId: "ws-1", role: "admin" };
		expect(
			auditRecordOf("/organization/update-member-role", role, { replaced: { role: "admin" } }),
		).toBeNull();
		const workspace = { id: "ws-1", name: "Acme", slug: "acme" };
		expect(
			auditRecordOf("/organization/update", workspace, {
				body: { data: { name: "Acme" } },
				replaced: { name: "Acme", slug: "acme" },
			}),
		).toBeNull();
	});

	it("records only what a workspace update asked to change", () => {
		const workspace = { id: "ws-1", name: "Acme", slug: "acme-co" };
		expect(
			auditRecordOf("/organization/update", workspace, {
				body: { data: { slug: "acme-co", logo: "x" } },
				replaced: { name: "Acme", slug: "acme" },
			})?.record.detail,
		).toEqual({ slug: "acme-co", previousSlug: "acme" });
	});
});
