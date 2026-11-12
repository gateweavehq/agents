import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AuditPage } from "#/lib/audit-events";

export interface WorkspaceAudit {
	admin: boolean;
	page: AuditPage;
}

const none: AuditPage = { events: [], people: {}, next: null };

/**
 * A page of the workspace's audit log, the newest first, for owners and admins. Null for
 * non-members; members who are not admins get an empty page and `admin: false`.
 */
export const getAuditLog = createServerFn({ method: "GET" })
	.validator(
		z.object({
			slug: z.string().min(1),
			before: z.number().int().positive().optional(),
		}),
	)
	.handler(async ({ data }): Promise<WorkspaceAudit | null> => {
		const [{ currentMember }, { isAdmin }] = await Promise.all([
			import("#/server/access"),
			import("#/lib/roles"),
		]);
		const member = await currentMember(data.slug);
		if (!member) return null;
		if (!isAdmin(member.membership.role)) return { admin: false, page: none };
		const [{ db }, { readAuditPage }] = await Promise.all([
			import("#/server/auth"),
			import("#/server/audit"),
		]);
		return {
			admin: true,
			page: await readAuditPage(db, member.membership.workspaceId, data.before),
		};
	});
