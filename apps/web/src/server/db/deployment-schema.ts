import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/**
 * "Who owns a server" in docs/architecture.md. One row: who runs this server, whether anyone may make
 * an account on it, and whether the sign-in provider vouches for people. The row comes from a
 * migration, and triggers there hold what it says.
 */
export const deployment = sqliteTable(
	"deployment",
	{
		id: integer("id").primaryKey(),
		ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
		signUp: text("sign_up", { enum: ["open", "closed"] }).notNull(),
		/** Whether an account made through the OpenID Connect provider needs no way in of its own. */
		trustProvider: integer("trust_provider", { mode: "boolean" }).notNull().default(false),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		check("deployment_one_row", sql`${table.id} = 1`),
		check("deployment_sign_up", sql`${table.signUp} IN ('open', 'closed')`),
		check("deployment_trust_provider", sql`${table.trustProvider} IN (0, 1)`),
	],
);

/**
 * The owner's list of who may make an account while sign-up is closed: an address, lowercased, or a
 * domain with a leading `@`. It holds people who may have no account yet, so it is personal data.
 */
export const signUpAllow = sqliteTable(
	"sign_up_allow",
	{
		entry: text("entry").primaryKey(),
		note: text("note"),
		addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
		/** The owner's id. Not a foreign key: the list outlives the account that made it. */
		addedBy: text("added_by").notNull(),
	},
	(table) => [
		check("sign_up_allow_lowercase", sql`${table.entry} = lower(${table.entry})`),
		check("sign_up_allow_note", sql`${table.note} IS NULL OR length(${table.note}) <= 200`),
	],
);
