import { inspect } from "node:util";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../auth/config";
import { createDb, schema } from ".";
import { faulty, LOCAL, migratedD1 } from "./faulty-d1";
import { DatabaseError, withoutStatements } from "./query-failure";
import { READ_ATTEMPTS } from "./retry-reads";

// A query of D1 that failed for good. Drizzle's error for it is `Failed query: select …
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

/** The lines this module logs: a kind and a reference each, and the statement if there was one. */
const failures = () =>
	printed.flatMap((line) => {
		const found = /^error: d1: a query failed \((.+?)\), reference ([0-9a-f]{8})(?:: (.+))?$/.exec(
			line,
		);
		return found ? [{ kind: found[1], reference: found[2], statement: found[3] }] : [];
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
	it("logs the statement and none of its values, so no token", async () => {
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
		// What Better Auth logs is the error, which has nothing of the statement.
		const theirs = printed.filter((line) => line.includes("[Better Auth]")).join("\n");
		expect(theirs).not.toMatch(/select/i);
		expect(inspect(error, { depth: 8 })).not.toContain(token);
		expect(inspect(error, { depth: 8 })).not.toMatch(/select/i);

		// Still enough to find it by: the kind in the log, under the reference the error has.
		const cause = (error as Error).cause;
		expect(cause).toBeInstanceOf(DatabaseError);
		const { kind, reference } = cause as DatabaseError;
		expect(kind).toBe("D1_ERROR, local-commit-token");
		const [failure, ...others] = failures();
		expect(others).toEqual([]);
		expect(failure).toMatchObject({ kind, reference });
		// The statement as it was sent, with a `?` where the token was.
		expect(failure?.statement).toMatch(/^select "id", .* where "session"\."token" = \? limit \?$/);
		// The cause says the kind and nothing else, for code that reads causes.
		expect(((cause as Error).cause as Error).message).toBe(kind);
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
		expect((error as DatabaseError).kind).toBe("D1_ERROR, queued-too-long");
		expect(failures()).toMatchObject([
			{ kind: "D1_ERROR, queued-too-long", reference: (error as DatabaseError).reference },
		]);
		// The log has the statement, with a `?` where the value was.
		expect(failures()[0]?.statement).toMatch(/ from "member" where "member"\."user_id" = \?$/);
		expect(logged()).not.toContain(SECRET);
		expect(logged()).not.toContain("params");
	});

	it("logs a statement with a token among its values, and not the token", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		const token = "kJ8sT0kEnT0kEnT0kEnT0kEnT0kEn";
		state.failures = 1;
		state.message = "D1_ERROR: something nobody has seen before";

		await thrownBy(() =>
			db.select().from(schema.session).where(eq(schema.session.token, token)).all(),
		);

		expect(failures()[0]?.statement).toMatch(/ from "session" where "session"\."token" = \?$/);
		expect(logged()).not.toContain(token);
	});

	it("cuts a long statement short", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		const ids = Array.from({ length: 400 }, (_, index) => `id-${index}`);

		await thrownBy(() =>
			db.select().from(schema.member).where(inArray(schema.member.userId, ids)).all(),
		);

		const statement = failures()[0]?.statement ?? "";
		expect(statement.length).toBe(601);
		expect(statement.endsWith("…")).toBe(true);
	});

	// What Cloudflare's D1 error list and SQLite say in fixed words, by a name each.
	it.each([
		["overloaded", "D1_ERROR: D1 DB is overloaded."],
		["queue-full", "D1_ERROR: D1 DB is overloaded. Too many requests queued."],
		["cpu-reset", "D1_ERROR: D1 DB exceeded its CPU time limit and was reset."],
		["memory-reset", "D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset."],
		[
			"storage-timeout",
			"D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
		],
		[
			"response-too-large",
			"D1_ERROR: D1 query result exceeded the maximum response size limit of 50 MB",
		],
		["too-many-variables", "D1_ERROR: too many SQL variables at offset 412: SQLITE_ERROR"],
		["syntax-error", 'D1_ERROR: near "form": syntax error at offset 9: SQLITE_ERROR'],
	])("names what D1 says in fixed words: %s", async (label, message) => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = message;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		const sqlite = message.endsWith(": SQLITE_ERROR") ? "SQLITE_ERROR, " : "";
		expect((error as DatabaseError).kind).toBe(`D1_ERROR, ${sqlite}${label}`);
	});

	it("names a failure without D1's code by its fixed words alone", async () => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = "Too many API requests by single worker invocation.";

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("too-many-api-requests");
	});

	// Words that name a table or a code may be what a row held, wherever D1 quotes one.
	it.each([
		[
			"a table's name inside a body it could not read",
			'D1_ERROR: Failed to parse body as JSON, got: {"note":"no such table: SECRETWORD"}',
			"SECRETWORD",
		],
		["a code in the middle of its words", "D1_ERROR: row said SQLITE_SECRET_WORD", "SECRET_WORD"],
		[
			"a constraint's name after a colon further in",
			"D1_ERROR: Failed to parse body as JSON, got: UNIQUE constraint failed: SECRETWORD",
			"SECRETWORD",
		],
	])("quotes D1 only where it speaks for itself, not %s", async (_what, message, word) => {
		const { database, state } = faulty(real);
		const db = createDb(database);
		state.failures = 1;
		state.message = message;

		const error = await thrownBy(() => db.select().from(schema.member).all());

		expect((error as DatabaseError).kind).toBe("D1_ERROR");
		expect(inspect(error, { depth: 8 })).not.toContain(word);
		expect(logged()).not.toContain(word);
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

	it("leaves alone what fails while a batch is put together, before the database is asked", async () => {
		const db = createDb(real);
		const broken = new TypeError("not a query");
		const notAQuery = {
			_prepare() {
				throw broken;
			},
		};

		const error = await thrownBy(() =>
			db.batch([notAQuery] as unknown as Parameters<typeof db.batch>[0]),
		);

		expect(error).toBe(broken);
		expect(printed).toEqual([]);
	});

	it("leaves a query that worked alone", async () => {
		const db = createDb(real);
		expect(await db.select().from(schema.member).where(eq(schema.member.userId, "nobody"))).toEqual(
			[],
		);
		expect(printed).toEqual([]);
	});
});

// None of what `withoutStatements` reaches for is in Drizzle's public types, so a version may
// take it away. Then the statements would be in the errors again, and nothing would say so.
describe("a Drizzle that is not as expected", () => {
	const client = { batch: async () => [] };

	it.each([
		["no session", {}],
		["a session that prepares no query", { session: { client } }],
		["a session without its client", { session: { prepareQuery: () => ({}) } }],
		["a client that sends no batch", { session: { prepareQuery: () => ({}), client: {} } }],
	])("is refused when the database is made: %s", (_what, db) => {
		expect(() => withoutStatements(db)).toThrow("Drizzle's session cannot be reached");
	});

	it("is refused at the first query when a prepared query is sent by another name", () => {
		const session = { prepareQuery: () => ({ execute: async () => [] }), client };
		withoutStatements({ session });

		expect(() => session.prepareQuery()).toThrow("Drizzle's prepared query is sent some other way");
	});

	it("is accepted when a prepared query has any of the four", async () => {
		const session = { prepareQuery: () => ({ all: async () => ["a row"] }), client };
		withoutStatements({ session });

		expect(await session.prepareQuery().all()).toEqual(["a row"]);
	});

	// `pnpm auth:schema` reads the configuration in `auth/cli.ts`, whose database is no binding at
	// all. Made with `createDb`, it was refused above and the generator stopped.
	it("still loads the configuration the schema generator reads, whose database is no binding", async () => {
		const { auth } = await import("../auth/cli");

		expect(auth.options.plugins?.length).toBeGreaterThan(0);
		// The oauth-provider tries its seed against it and fails, as it always has there: waited
		// for, so that whatever it says is said inside this test.
		await auth.$context;
	});
});

// Better Auth's oauth-provider, which `mcp({ resource })` is built on, writes the resource into
// `oauth_resource` as it starts. Before the migrations have run there is no such table, which it
// expects and notes at debug level; anything else it logs as an error. It tells the two apart by
// reading the failure's causes for SQLite's words.
describe("a database that has not been migrated yet", () => {
	it("is still what the oauth-provider takes a missing table for", async () => {
		const { d1, dispose: disposeEmpty } = await migratedD1("query-failure-empty", {
			migrate: false,
		});
		try {
			const auth = createAuth({
				db: createDb(d1),
				secret: "a-test-secret-that-is-long-enough-for-better-auth",
				baseURL: "https://agents.test",
				mcpResource: "https://agents.test/mcp",
			});
			await auth.$context;

			// It did ask, and the table was not there.
			expect(failures().map(({ kind }) => kind)).toContain(
				"D1_ERROR, SQLITE_ERROR, no such table: oauth_resource",
			);
			expect(logged()).not.toContain("could not seed");
		} finally {
			await disposeEmpty();
		}
	});
});

describe("what SQLite refused, in the local runtime's own words", () => {
	it.each([
		["a table that is not there", "select * from nope", "SQLITE_ERROR, no such table: nope"],
		["a column that is not there", "select nope from member", "SQLITE_ERROR, no such column: nope"],
		["a statement it cannot read", "selec 1", "SQLITE_ERROR, syntax-error"],
	])("names %s", async (_what, statement, kind) => {
		const db = createDb(real);

		const error = await thrownBy(() => db.run(sql.raw(statement)));

		expect((error as DatabaseError).kind).toBe(`D1_ERROR, ${kind}`);
	});
});
