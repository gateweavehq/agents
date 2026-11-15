import { inspect } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../auth/config";
import { createDb, schema } from ".";
import { faulty, LOCAL, migratedD1 } from "./faulty-d1";
import { DatabaseError } from "./query-failure";
import { READ_ATTEMPTS } from "./retry-reads";

// A query of D1 that failed for good (AGT-133). Drizzle's error for it is `Failed query: select …
// params: …`, with every value the statement was given. Better Auth logged the one for a session
// read, token included, and a page showed the one for its own read.

let real: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ d1: real, dispose } = await migratedD1("query-failure-test"));
});

afterAll(async () => {
	await dispose?.();
});

/** Every call to the console, as the console would print it: an error's fields and causes too. */
let printed: string[];

beforeEach(() => {
	printed = [];
	for (const level of ["error", "warn", "info", "log", "debug"] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			printed.push(
				`${level}: ${args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 8 }))).join(" ")}`,
			);
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

const logged = () => printed.join("\n");

/** The lines this module logs: a kind and a reference each. */
const failures = () =>
	printed.flatMap((line) => {
		const found = /^error: d1: a query failed \((.+)\), reference ([0-9a-f]{8})$/.exec(line);
		return found ? [{ kind: found[1], reference: found[2] }] : [];
	});

/** What threw, or nothing. */
async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("a session read that failed for good", () => {
	it("logs no token, no statement and no values", async () => {
		const { database, state } = faulty(real);
		const auth = createAuth({
			db: createDb(database),
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "https://agents.test",
		});
		const { headers } = await auth.api.signUpEmail({
			body: { name: "Rio", email: "rio@failure.test", password: "a-long-test-password" },
			returnHeaders: true,
		});
		const cookie = headers
			.getSetCookie()
			.map((line) => line.split(";")[0])
			.join("; ");
		const value = decodeURIComponent(/session_token=([^;]+)/.exec(cookie)?.[1] ?? "");
		const token = value.split(".")[0] ?? "";
		// The token the cookie carries is the one the statement looks for.
		const stored = await real.prepare("select token from session").all<{ token: string }>();
		expect(stored.results.map((row) => row.token)).toContain(token);

		printed.length = 0;
		state.failures = READ_ATTEMPTS;
		const error = await thrownBy(() => auth.api.getSession({ headers: new Headers({ cookie }) }));

		// Better Auth logs what it caught, and throws its own error with that as the cause.
		expect(logged()).toContain("[Better Auth]");
		expect(logged()).not.toContain(token);
		expect(logged()).not.toContain("Failed query");
		expect(logged()).not.toContain("params");
		expect(logged()).not.toMatch(/select/i);
		expect(inspect(error, { depth: 8 })).not.toContain(token);
		expect(inspect(error, { depth: 8 })).not.toMatch(/select/i);

		// Still enough to find it by: the kind in the log, under the reference the error has.
		const cause = (error as Error).cause;
		expect(cause).toBeInstanceOf(DatabaseError);
		const { kind, reference } = cause as DatabaseError;
		expect(kind).toBe("D1_ERROR, local-commit-token");
		expect(failures()).toEqual([{ kind, reference }]);
		expect((cause as DatabaseError).message).toBe(
			`A database query failed (reference ${reference})`,
		);
	});
});

describe("a query that failed", () => {
	const SECRET = "a-value-nobody-should-see";

	it("throws an error without its statement or its values", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";

		const error = await thrownBy(() =>
			db.select().from(schema.member).where(eq(schema.member.userId, SECRET)).all(),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		const shown = inspect(error, { depth: 8 });
		expect(shown).not.toContain(SECRET);
		expect(shown).not.toMatch(/select|params|user_id/i);
		expect((error as DatabaseError).kind).toBe("D1_ERROR");
		expect(failures()).toEqual([
			{ kind: "D1_ERROR", reference: (error as DatabaseError).reference },
		]);
		expect(logged()).not.toContain(SECRET);
	});

	it.each([
		["get", (db: ReturnType<typeof createDb>) => db.select().from(schema.member).get()],
		["values", (db: ReturnType<typeof createDb>) => db.select().from(schema.member).values()],
		["run", (db: ReturnType<typeof createDb>) => db.delete(schema.member).run()],
		["await", async (db: ReturnType<typeof createDb>) => await db.select().from(schema.member)],
		[
			"the relational API",
			(db: ReturnType<typeof createDb>) =>
				db.query.member.findFirst({ where: eq(schema.member.userId, SECRET) }),
		],
		[
			"a transaction",
			(db: ReturnType<typeof createDb>) =>
				db.transaction((tx) => tx.select().from(schema.member).all()),
		],
	])("whichever way it was sent: %s", async (_way, send) => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		// A transaction's `begin` and `rollback` fail too, whichever comes first.
		state.failures = 3;
		state.message = "D1_ERROR: something nobody has seen before";

		const error = await thrownBy(() => send(db));

		expect(error).toBeInstanceOf(DatabaseError);
		expect(inspect(error, { depth: 8 })).not.toMatch(/select|delete|begin|params/i);
	});

	it("names a constraint, which is the schema's and no value", async () => {
		const db = createDb(real);
		const row = { id: "twice", identifier: SECRET, value: SECRET, expiresAt: new Date(1) };
		await db.insert(schema.verification).values(row);

		const error = await thrownBy(() => db.insert(schema.verification).values(row).run());

		expect(error).toBeInstanceOf(DatabaseError);
		expect((error as DatabaseError).kind).toBe(
			"D1_ERROR, SQLITE_CONSTRAINT, UNIQUE constraint failed: verification.id",
		);
		expect(inspect(error, { depth: 8 })).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("names a passing failure that outlasted its resends", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = READ_ATTEMPTS;
		state.message = LOCAL;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("D1_ERROR, local-commit-token");
	});

	it("repeats nothing D1 said beyond that: its words can carry what a row held", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = `D1_ERROR: Failed to parse body as JSON, got: {"token":"${SECRET}"}`;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("D1_ERROR");
		expect(inspect(error, { depth: 8 })).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("says as little when a batch fails, which fails in D1's words", async () => {
		const db = createDb(real);

		const error = await thrownBy(() =>
			db.batch([
				db.insert(schema.verification).values({
					id: "batched",
					identifier: SECRET,
					value: SECRET,
					expiresAt: new Date(1),
				}),
				db.insert(schema.verification).values({
					id: "batched",
					identifier: SECRET,
					value: SECRET,
					expiresAt: new Date(1),
				}),
			]),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect((error as DatabaseError).kind).toContain("UNIQUE constraint failed: verification.id");
		expect(inspect(error, { depth: 8 })).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("leaves a query that worked alone", async () => {
		const db = createDb(real);
		expect(await db.select().from(schema.member).where(eq(schema.member.userId, "nobody"))).toEqual(
			[],
		);
		expect(printed).toEqual([]);
	});
});
