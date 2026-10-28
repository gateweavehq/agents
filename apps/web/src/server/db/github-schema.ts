import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth-schema";

/**
 * GitHub App installations linked to a workspace. Webhooks name the installation, and this is
 * how they find the workspace. An installation is linked to one workspace at a time.
 */
export const githubInstallation = sqliteTable(
	"github_installation",
	{
		/** GitHub's id for the installation. */
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		accountLogin: text("account_login").notNull(),
		/** "User" or "Organization". */
		accountType: text("account_type").notNull(),
		linkedBy: text("linked_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("github_installation_workspace_idx").on(table.workspaceId)],
);
