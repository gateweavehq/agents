import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../auth/config";
import { createDb } from ".";
import { faulty, LOCAL, migratedD1 } from "./faulty-d1";
import { READ_ATTEMPTS, retryingReads } from "./retry-reads";

// A read of D1 that fails for a moment. Under load, the local runtime's D1 answered one
// read of a session with the error below, and a signed-in person's page was a 500 that said
// "Failed to get session". The database here is a real one, with the failure put in front of it.

let real: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ d1: real, dispose } = await migratedD1("retry-reads-test"));
});

afterAll(async () => {
	await dispose?.();
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

/** Everything `console.warn` was given, as one text. */
const logged = () =>
	warned.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");

it("answers a session read that failed once", async () => {
	const { database, state } = faulty(real);
	const { auth, cookie } = await signedUp(database, "rio@example.com");

	state.sent.length = 0;
	state.failures = 1;
	const found = await auth.api.getSession({ headers: new Headers({ cookie }) });

	expect(found?.user.email).toBe("rio@example.com");
	expect(state.sent).toHaveLength(2);
	expect(warned).toHaveBeenCalledTimes(1);
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

describe("which failures are sent again", () => {
	// The texts Cloudflare's D1 error list answers with "Retry the operation", as D1 words them,
	// and the local runtime's.
	it.each([
		["connection-lost", "D1_ERROR: Network connection lost."],
		["storage-reset", "D1_ERROR: Internal error in D1 DB storage caused object to be reset."],
		[
			"storage-reset",
			"D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
		],
		["code-updated", "D1_ERROR: D1 DB reset because its code was updated."],
		["replica-disconnected", "D1_ERROR: Replica disconnected from primary."],
		["cannot-resolve", "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node."],
		["local-commit-token", LOCAL],
	])("a passing one (%s), logged by that name", async (label, message) => {
		const { database, state } = faulty(real);
		const d1 = retryingReads(database, { random: () => 0 });
		state.failures = 1;
		state.message = message;

		const rows = await d1.prepare("select ? as n").bind(7).all<{ n: number }>();

		expect(rows.results[0]?.n).toBe(7);
		expect(state.sent).toHaveLength(2);
		expect(logged()).toBe(`d1: a read failed (${label}) and is sent again (attempt 1)`);
	});

	it.each([
		["an overloaded database", "D1_ERROR: D1 DB is overloaded. Requests queued for too long."],
		["a full queue", "D1_ERROR: D1 DB is overloaded. Too many requests queued."],
		["too much CPU", "D1_ERROR: D1 DB exceeded its CPU time limit and was reset."],
		["too much memory", "D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset."],
		[
			"a write that took too long",
			"D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
		],
		[
			"too large a result",
			"D1_ERROR: D1 query result exceeded the maximum response size limit of 50 MB",
		],
		["too many requests", "Too many API requests by single worker invocation."],
		// The list says to retry this one, but a resend cannot help a caller who left.
		["a caller who left", "D1_ERROR: Can't read from request stream because client disconnected."],
		["the wrong number of values", "D1_ERROR: Wrong number of parameter bindings for SQL query."],
		["a column that is not there", "D1_COLUMN_NOTFOUND: Column not found (missing)"],
		["one nobody knows", "D1_ERROR: something nobody has seen before"],
	])("not %s: thrown at once", async (_what, message) => {
		const { database, state } = faulty(real);
		const d1 = retryingReads(database, { random: () => 0 });
		state.failures = 1;
		state.message = message;

		await expect(d1.prepare("select 1").all()).rejects.toThrow(message);

		expect(state.sent).toHaveLength(1);
		expect(warned).not.toHaveBeenCalled();
	});

	it("not what SQLite refused, which it would refuse again", async () => {
		const { database, state } = faulty(real);
		const d1 = retryingReads(database);

		await expect(d1.prepare("select * from no_such_table").all()).rejects.toThrow("SQLITE_ERROR");

		expect(state.sent).toHaveLength(1);
		expect(warned).not.toHaveBeenCalled();
	});
});

it("logs nothing D1 said: its words can carry what a row held", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database, { random: () => 0 });
	const token = "kJ8sT0kEnT0kEnT0kEnT0kEnT0kEn";
	const address = "someone@example.com";
	state.failures = 1;
	// As workerd words a body it could not read, with a passing failure's text inside it.
	state.message = `D1_ERROR: Failed to parse body as JSON, got: {"token":"${token}","email":"${address}"} Network connection lost.`;

	await d1.prepare("select 1").all();

	expect(warned).toHaveBeenCalledTimes(1);
	expect(logged()).not.toContain(token);
	expect(logged()).not.toContain(address);
	expect(logged()).toBe("d1: a read failed (connection-lost) and is sent again (attempt 1)");
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
	).rejects.toThrow(LOCAL);

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

it("sends a select once when another statement follows it, which may write", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database);
	state.failures = 1;

	await expect(
		d1
			.prepare(
				"select 1; insert into verification (id, identifier, value, expires_at) values ('two', 'two', 'two', 1)",
			)
			.all(),
	).rejects.toThrow(LOCAL);

	expect(state.sent).toHaveLength(1);
	expect(warned).not.toHaveBeenCalled();
});

it("still sends again a select that only ends with a semicolon", async () => {
	const { database, state } = faulty(real);
	const d1 = retryingReads(database, { random: () => 0 });
	state.failures = 1;

	const rows = await d1.prepare("select 3 as n;\n").all<{ n: number }>();

	expect(rows.results[0]?.n).toBe(3);
	expect(state.sent).toHaveLength(2);
});

it("leaves a batch to the database as it was given", async () => {
	const d1 = retryingReads(real);
	const [one, two] = await d1.batch<{ n: number }>([
		d1.prepare("select ? as n").bind(1),
		d1.prepare("select ? as n").bind(2),
	]);
	expect([one?.results[0]?.n, two?.results[0]?.n]).toEqual([1, 2]);
});

describe("a session of the database", () => {
	it("has its reads sent again too, and its writes once", async () => {
		const { database, state } = faulty(real);
		const session = retryingReads(database, { random: () => 0 }).withSession("first-primary");

		state.failures = 1;
		const rows = await session.prepare("select ? as n").bind(5).all<{ n: number }>();
		expect(rows.results[0]?.n).toBe(5);
		expect(state.sent).toHaveLength(2);

		state.sent.length = 0;
		state.failures = 1;
		await expect(
			session
				.prepare("insert into verification (id, identifier, value, expires_at) values (?, ?, ?, ?)")
				.bind("in-session", "s", "s", 1)
				.run(),
		).rejects.toThrow(LOCAL);
		expect(state.sent).toHaveLength(1);
	});

	it("keeps its bookmark and its batch", async () => {
		const session = retryingReads(real).withSession("first-primary");
		const unwrapped = real.withSession("first-primary");
		expect(session.getBookmark()).toBe(unwrapped.getBookmark());

		const [one] = await session.batch<{ n: number }>([session.prepare("select ? as n").bind(9)]);
		expect(one?.results[0]?.n).toBe(9);

		await unwrapped.prepare("select 1").all();
		await session.prepare("select 1").all();
		expect(typeof session.getBookmark()).toBe(typeof unwrapped.getBookmark());
	});
});

describe("the waits between attempts", () => {
	/** The waits a read that failed twice asked for, in milliseconds, without waiting them. */
	async function failingTwice(random: () => number) {
		const { database, state } = faulty(real);
		const waits: number[] = [];
		const d1 = retryingReads(database, {
			random,
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});
		state.failures = 2;
		await d1.prepare("select 1").all();
		return waits;
	}

	it("are half as long at the least and half as long again at the most", async () => {
		expect(await failingTwice(() => 0)).toEqual([12.5, 50]);
		expect(await failingTwice(() => 0.5)).toEqual([25, 100]);
		expect(await failingTwice(() => 1)).toEqual([37.5, 150]);
	});

	it("differ from one read to the next", async () => {
		const drawn = [0.1, 0.9];
		expect(await failingTwice(() => drawn.shift() ?? 0)).toEqual([15, 140]);
	});
});
