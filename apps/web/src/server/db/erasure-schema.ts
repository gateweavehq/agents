import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organization } from "./auth-schema";

/**
 * Workspaces someone left, which a trigger on `member` notes. They keep that person's conversations,
 * since a registry goes by ids, so deleting the account later has to reach them too.
 */
export const formerMember = sqliteTable(
	"former_member",
	{
		userId: text("user_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.organizationId] }),
		index("formerMember_organizationId_idx").on(table.organizationId),
	],
);

/**
 * Workspaces that still have to forget someone whose account is gone. Deleting the account writes
 * these in the same transaction, a row goes once its registry has answered, and the daily cron asks
 * again for any that did not. Nothing else would ever notice one that was missed.
 */
export const pendingErasure = sqliteTable(
	"pending_erasure",
	{
		userId: text("user_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
		/** When asking last failed. The cron goes by it, so those that keep failing wait their turn. */
		lastTriedAt: integer("last_tried_at"),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.organizationId] }),
		index("pendingErasure_organizationId_idx").on(table.organizationId),
		index("pendingErasure_lastTriedAt_idx").on(table.lastTriedAt, table.createdAt),
	],
);
