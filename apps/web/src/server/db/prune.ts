import { type Column, inArray, lt } from "drizzle-orm";
import type { Database } from "./index";
import { schema } from "./index";

/** D1 runs one query at a time, so one long delete would hold up everyone signing in. */
const BATCH = 1000;

async function pruneOlder(
	db: Database,
	table:
		| typeof schema.session
		| typeof schema.verification
		| typeof schema.oauthRefreshToken
		| typeof schema.oauthAccessToken
		| typeof schema.oauthClientAssertion
		| typeof schema.invitation,
	column: Column,
	before: Date,
) {
	for (;;) {
		const expired = db.select({ id: table.id }).from(table).where(lt(column, before)).limit(BATCH);
		const { meta } = await db.delete(table).where(inArray(table.id, expired)).run();
		if (meta.changes < BATCH) return;
	}
}

/**
 * Deletes what is past its time. Better Auth removes a session or a verification only when something
 * looks it up, so those nobody comes back for would otherwise stay forever: a session holds the
 * address and browser it came from, a verification an abandoned sign-up's code, and an invitation an
 * address that may never have had anything to do with this deployment. OAuth tokens name the person
 * an agent acts as. The privacy policy states
 * these, so a change here is a change to it.
 */
export async function pruneExpired(db: Database): Promise<void> {
	const now = new Date();
	await pruneOlder(db, schema.session, schema.session.expiresAt, now);
	await pruneOlder(db, schema.verification, schema.verification.expiresAt, now);
	// Refresh tokens first, because deleting one takes the access tokens made from it along.
	await pruneOlder(db, schema.oauthRefreshToken, schema.oauthRefreshToken.expiresAt, now);
	await pruneOlder(db, schema.oauthAccessToken, schema.oauthAccessToken.expiresAt, now);
	await pruneOlder(db, schema.oauthClientAssertion, schema.oauthClientAssertion.expiresAt, now);
	await pruneOlder(db, schema.invitation, schema.invitation.expiresAt, now);
}
