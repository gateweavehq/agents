import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AuditAction, AuditDetail, AuditTargetType } from "../../lib/audit-events";
import { organization } from "./auth-schema";

/**
 * Each workspace's audit log (`server/audit.ts`). Written by the Worker after a change succeeds,
 * since the registry is never told who asks. Goes with the workspace, and after a year.
 */
export const auditEvent = sqliteTable(
	"audit_event",
	{
		id: integer("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		at: integer("at").notNull(),
		/** Not a reference: the log outlives the account, which then reads as a deleted member. */
		actorId: text("actor_id"),
		action: text("action").$type<AuditAction>().notNull(),
		targetType: text("target_type").$type<AuditTargetType>().notNull(),
		targetId: text("target_id"),
		targetLabel: text("target_label"),
		detail: text("detail", { mode: "json" }).$type<AuditDetail>().notNull(),
	},
	(table) => [
		index("auditEvent_organizationId_id_idx").on(table.organizationId, table.id),
		index("auditEvent_at_idx").on(table.at),
	],
);
