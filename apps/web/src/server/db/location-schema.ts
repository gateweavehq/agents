import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Where each workspace's Durable Objects are ("Where a workspace lives" in docs/architecture.md):
 * the jurisdiction its registry and conversations were made in, or moved to. A workspace with no row
 * has them outside any jurisdiction, where they were made before this table. The same name in
 * another jurisdiction is another object, so every way in reads this first.
 */
export const workspaceLocation = sqliteTable("workspace_location", {
	/** Not a foreign key: the row outlives the workspace until its objects are destroyed. */
	workspaceId: text("workspace_id").primaryKey(),
	jurisdiction: text("jurisdiction").notNull(),
	/**
	 * Where it was before it moved here, "" for outside any jurisdiction. The objects there are
	 * sealed. Once the daily run forgets them, this is null.
	 */
	movedFrom: text("moved_from"),
	/** When it moved here, or null if it was made here. */
	movedAt: integer("moved_at"),
});

/**
 * Deleted workspaces whose objects may still hold something: conversations, the registry, a sealed
 * old copy ("Deleting a workspace" in docs/architecture.md). Deleting a workspace writes one in the
 * same batch as its row, it goes with the location row once all of that is gone, and the daily run
 * finishes any left. Not a reference to the workspace, whose row is gone.
 */
export const workspaceDeletion = sqliteTable(
	"workspace_deletion",
	{
		workspaceId: text("workspace_id").primaryKey(),
		deletedAt: integer("deleted_at").notNull(),
		/** When finishing it last failed. The daily run goes by it, so one that keeps failing waits. */
		lastTriedAt: integer("last_tried_at"),
	},
	(table) => [index("workspaceDeletion_lastTriedAt_idx").on(table.lastTriedAt, table.deletedAt)],
);
