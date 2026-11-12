import { z } from "zod";
import type { AuditRecord } from "../audit";

/**
 * Better Auth's changes to who belongs to a workspace, turned into events for its audit log
 * (`server/audit.ts`). Its organization hooks are told whom a change was done to, but not who did
 * it, so the events are made in the after hook, from the session and what the path answered.
 * What a change replaced, a role or a name, is read before it is made. The same as Track's.
 */

/** The paths whose changes the audit log records, and what each answers. */
const answers = {
	"/organization/invite-member": z.object({
		id: z.string(),
		email: z.string(),
		role: z.string(),
		organizationId: z.string(),
	}),
	"/organization/cancel-invitation": z.object({
		id: z.string(),
		email: z.string(),
		organizationId: z.string(),
	}),
	"/organization/accept-invitation": z.object({
		member: z.object({ userId: z.string(), organizationId: z.string(), role: z.string() }),
	}),
	"/organization/remove-member": z.object({
		member: z.object({ userId: z.string(), organizationId: z.string() }),
	}),
	"/organization/update-member-role": z.object({
		userId: z.string(),
		organizationId: z.string(),
		role: z.string(),
	}),
	"/organization/leave": z.object({ userId: z.string(), organizationId: z.string() }),
	"/organization/update": z.object({ id: z.string(), name: z.string(), slug: z.string() }),
};

export type AuditedPath = keyof typeof answers;

export function isAuditedPath(path: string | undefined): path is AuditedPath {
	return path !== undefined && Object.hasOwn(answers, path);
}

/** What a change replaced, read before it was made. */
export interface Replaced {
	role?: string;
	name?: string;
	slug?: string;
}

export interface WorkspaceRecord {
	workspaceId: string;
	record: AuditRecord;
}

/**
 * The event for what an audited path did, from what it answered: null when it changed nothing,
 * as when it answered with an error.
 */
export function auditRecordOf(
	path: AuditedPath,
	answer: unknown,
	{ body, replaced }: { body?: unknown; replaced?: Replaced | undefined } = {},
): WorkspaceRecord | null {
	const made = (
		workspaceId: string,
		action: AuditRecord["action"],
		target: AuditRecord["target"],
		detail: Record<string, string | boolean> = {},
	): WorkspaceRecord => ({ workspaceId, record: { action, target, detail } });

	switch (path) {
		case "/organization/invite-member": {
			const invitation = answers[path].safeParse(answer);
			if (!invitation.success) return null;
			const { id, email, role, organizationId } = invitation.data;
			const resent = z.object({ resend: z.literal(true) }).safeParse(body).success;
			return made(
				organizationId,
				"invitation.created",
				{ type: "invitation", id, label: email.toLowerCase() },
				{ role, ...(resent && { resent: true }) },
			);
		}
		case "/organization/cancel-invitation": {
			const invitation = answers[path].safeParse(answer);
			if (!invitation.success) return null;
			const { id, email, organizationId } = invitation.data;
			return made(organizationId, "invitation.canceled", {
				type: "invitation",
				id,
				label: email.toLowerCase(),
			});
		}
		case "/organization/accept-invitation": {
			const accepted = answers[path].safeParse(answer);
			if (!accepted.success) return null;
			const { userId, organizationId, role } = accepted.data.member;
			return made(organizationId, "member.joined", member(userId), { role });
		}
		case "/organization/remove-member": {
			const removed = answers[path].safeParse(answer);
			if (!removed.success) return null;
			const { userId, organizationId } = removed.data.member;
			return made(organizationId, "member.removed", member(userId));
		}
		case "/organization/update-member-role": {
			const updated = answers[path].safeParse(answer);
			if (!updated.success) return null;
			const { userId, organizationId, role } = updated.data;
			if (replaced?.role === role) return null;
			return made(organizationId, "member.roleChanged", member(userId), {
				...(replaced?.role && { from: replaced.role }),
				to: role,
			});
		}
		case "/organization/leave": {
			const left = answers[path].safeParse(answer);
			if (!left.success) return null;
			const { userId, organizationId } = left.data;
			return made(organizationId, "member.left", member(userId));
		}
		case "/organization/update": {
			const workspace = answers[path].safeParse(answer);
			if (!workspace.success) return null;
			const { id, name, slug } = workspace.data;
			// Only what the request asked to change, as what it replaced may not be known.
			const asked = z
				.object({ data: z.object({ name: z.unknown(), slug: z.unknown() }).partial() })
				.safeParse(body);
			const data = asked.success ? asked.data.data : {};
			const detail: Record<string, string> = {};
			if ("name" in data && replaced?.name !== name) {
				Object.assign(
					detail,
					{ name },
					replaced?.name !== undefined && { previousName: replaced.name },
				);
			}
			if ("slug" in data && replaced?.slug !== slug) {
				Object.assign(
					detail,
					{ slug },
					replaced?.slug !== undefined && { previousSlug: replaced.slug },
				);
			}
			if (Object.keys(detail).length === 0) return null;
			return made(id, "workspace.updated", { type: "workspace", id, label: name }, detail);
		}
	}
}

function member(userId: string): AuditRecord["target"] {
	return { type: "member", id: userId, label: null };
}
