// Entry point for `pnpm auth:schema` only. The Better Auth CLI reads the configuration to
// generate the Drizzle schema; it never connects to a database.
import { createDb } from "../db";
import { createAuth } from "./config";

export const auth = createAuth({
	db: createDb({} as D1Database),
	secret: "schema-generation-only",
	// Every optional plugin, so the schema has every table. The OAuth server needs a base URL.
	baseURL: "http://localhost:4720",
	mcpResource: "http://localhost:4720/mcp",
});
