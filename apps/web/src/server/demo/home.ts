import { eq } from "drizzle-orm";
import { db, getAuth } from "../auth";
import { schema } from "../db";

/** The slug of the workspace of the visitor these headers sign in, or null when they have none. */
export async function demoHome(headers: Headers): Promise<string | null> {
	const found = await getAuth().api.getSession({ headers });
	if (!found) return null;
	const row = await db
		.select({ slug: schema.organization.slug })
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
		.where(eq(schema.member.userId, found.user.id))
		.get();
	return row?.slug ?? null;
}
