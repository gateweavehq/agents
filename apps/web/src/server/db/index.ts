import { drizzle } from "drizzle-orm/d1";
import { retryingReads } from "./retry-reads";
import * as schema from "./schema";

export function createDb(d1: D1Database) {
	return drizzle(retryingReads(d1), { schema });
}

export type Database = ReturnType<typeof createDb>;
export { schema };
