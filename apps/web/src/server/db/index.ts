import { drizzle } from "drizzle-orm/d1";
import { withoutStatements } from "./query-failure";
import { retryingReads } from "./retry-reads";
import * as schema from "./schema";

export function createDb(d1: D1Database) {
	const db = drizzle(retryingReads(d1), { schema });
	// A deployment without a database serves nothing (`notSetUp` in server.ts), and has to start
	// to say so: there is no query to fail, and no binding for `withoutStatements` to find.
	return d1 ? withoutStatements(db) : db;
}

export type Database = ReturnType<typeof createDb>;
export { schema };
