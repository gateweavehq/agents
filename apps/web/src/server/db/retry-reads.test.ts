import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createAuth } from "../auth/config";
import { createDb } from ".";
import { READ_ATTEMPTS, retryingReads } from "./retry-reads";

// A read of D1 that fails for a moment (AGT-131). Under load, the local runtime's D1 answered one
// read of a session with the error below, and a signed-in person's page was a 500 that said
// "Failed to get session". The database here is a real one, with the failure put in front of it.

const PASSING = "D1_ERROR: Failed to get session commit token: internal error; reference = test";

let mf: Miniflare;
let real: D1Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "retry-reads-test" },
		}),
	);
	real = (await mf.getD1Database("DB")) as unknown as D1Database;
	const migrations = resolve(import.meta.dirname, "../../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await real.batch(statements.map((statement) => real.prepare(statement)));
	}
});

afterAll(async () => {
	await mf?.dispose();
});

let warned: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warned = vi.spyOn(console, "warn").mockImplementation(() => {});
	// Better Auth logs a session read that failed for good.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The database, failing when told to: the next `failures` statements sent alone are refused as
 * the local runtime refused one, before they reach the database. `sent` lists every one that was
 * tried, refused or not.
 */
function faulty(d1: D1Database) {
	const state = { failures: 0, sent: [] as string[] };
	const sends = new Set<PropertyKey>(["all", "raw", "first", "run"]);
	const made = new WeakMap<object, D1PreparedStatement>();

	function watched(statement: D1PreparedStatement, query: string): D1PreparedStatement {
		const proxy = new Proxy(statement, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key === "bind") {
					return (...values: unknown[]) => watched(target.bind(...values), query);
				}
				if (!sends.has(key)) return value.bind(target);
				return async (...args: unknown[]) => {
					state.sent.push(query);
					if (state.failures > 0) {
						state.failures -= 1;
						throw new Error(PASSING);
					}
					return Reflect.apply(value, target, args);
				};
			},
		});
		made.set(proxy, statement);
		return proxy;
	}

	const database = new Proxy(d1, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key === "prepare") return (query: string) => watched(target.prepare(query), query);
			if (key === "batch") {
				return (statements: D1PreparedStatement[]) =>
					target.batch(statements.map((statement) => made.get(statement) ?? statement));
			}
			return value.bind(target);
		},
	});
	return { database, state };
}

async function signedUp(d1: D1Database, email: string) {
	const auth = createAuth({
		db: createDb(d1),
		secret: "a-test-secret-that-is-long-enough-for-better-auth",
		baseURL: "https://agents.test",
	});
	const { headers } = await auth.api.signUpEmail({
		body: { name: "Rio", email, password: "a-long-test-password" },
		returnHeaders: true,
	});
	const cookie = headers
		.getSetCookie()
		.map((line) => line.split(";")[0])
		.join("; ");
	return { auth, cookie };
}

it("answers a session read that failed once, and logs D1's words without the token", async () => {
	const { database, state } = faulty(real);
	const { auth, cookie } = await signedUp(database, "rio@example.com");
	const token = decodeURIComponent(/session_token=([^;]+)/.exec(cookie)?.[1] ?? "").split(".")[0];
	expect(token?.length).toBeGreaterThan(16);

	state.sent.length = 0;
	state.failures = 1;
	const found = await auth.api.getSession({ headers: new Headers({ cookie }) });

	expect(found?.user.email).toBe("rio@example.com");
	expect(state.sent).toHaveLength(2);
	expect(warned).toHaveBeenCalledTimes(1);
	const logged = String(warned.mock.calls[0]?.[0]);
	expect(logged).toContain("Failed to get session commit token");
	expect(logged).not.toContain(token);
});

it("gives up on a read that keeps failing, and answers the next one", async () => {
	const { database, state } = faulty(real);
	const { auth, cookie } = await signedUp(database, "sol@example.com");

	state.sent.length = 0;
	state.failures = READ_ATTEMPTS;
	await expect(auth.api.getSession({ headers: new Headers({ cookie }) })).rejects.toThrow(
		"Failed to get session",
	);
	expect(state.sent).toHaveLength(READ_ATTEMPTS);

	const found = await auth.api.getSession({ headers: new Headers({ cookie }) });
	expect(found?.user.email).toBe("sol@example.com");
});

it("sends a write once: it may have happened although its answer was lost", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database);
	state.failures = 1;

	await expect(
		d1
			.prepare("insert into verification (id, identifier, value, expires_at) values (?, ?, ?, ?)")
			.bind("once", "once", "once", 1)
			.run(),
	).rejects.toThrow(PASSING);

	expect(state.sent).toHaveLength(1);
	expect(warned).not.toHaveBeenCalled();
	// Sent again by hand, it is written once.
	await d1
		.prepare("insert into verification (id, identifier, value, expires_at) values (?, ?, ?, ?)")
		.bind("once", "once", "once", 1)
		.run();
	const rows = await d1.prepare("select id from verification where id = ?").bind("once").all();
	expect(rows.results).toHaveLength(1);
});

it("does not ask again what SQLite refused, which it would refuse again", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database);

	await expect(d1.prepare("select * from no_such_table").all()).rejects.toThrow("SQLITE_ERROR");

	expect(state.sent).toHaveLength(1);
	expect(warned).not.toHaveBeenCalled();
});

it("leaves a batch to the database as it was given", async () => {
	const d1 = retryingReads(real);
	const [one, two] = await d1.batch<{ n: number }>([
		d1.prepare("select ? as n").bind(1),
		d1.prepare("select ? as n").bind(2),
	]);
	expect([one?.results[0]?.n, two?.results[0]?.n]).toEqual([1, 2]);
});
