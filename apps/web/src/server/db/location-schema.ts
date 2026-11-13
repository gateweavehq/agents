import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
	 * sealed and keep what the workspace held then, until they are destroyed.
	 */
	movedFrom: text("moved_from"),
	/** When it moved here, or null if it was made here. */
	movedAt: integer("moved_at"),
});
