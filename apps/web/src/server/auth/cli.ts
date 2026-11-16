// Entry point for `pnpm auth:schema` only. The Better Auth CLI reads the configuration to
// generate the Drizzle schema; it never connects to a database. So the database is made here as
// Drizzle makes it: `createDb` wants a D1 binding to watch, and refuses a stand-in that has none.
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";
import { createAuth } from "./config";

export const auth = createAuth({
	db: drizzle({} as D1Database, { schema }),
	secret: "schema-generation-only",
	// Every optional plugin, so the schema has every table. The OAuth server needs a base URL.
	baseURL: "http://localhost:4720",
	mcpResource: "http://localhost:4720/mcp",
});
