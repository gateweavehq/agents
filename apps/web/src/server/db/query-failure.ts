import { DrizzleQueryError } from "drizzle-orm";
import { passing } from "./retry-reads";

/**
 * A query of D1 that failed, as everyone outside this folder gets it: what kind of failure it was
 * and a reference, and nothing of the statement.
 *
 * Drizzle's own error says `Failed query: select … params: …` with every value the statement was
 * given, and whoever catches it tends to log it or show it. Better Auth logged a session read
 * that failed, so the session's token was in the Worker's logs, and a page whose read failed
 * showed the statement and its values, in the page and in its HTML (AGT-133).
 *
 * The message holds the reference only, because a message travels: to a page, to a toast, into
 * the HTML. The kind is for the log, where the same reference finds it.
 */
export class DatabaseError extends Error {
	/** Such as `D1_ERROR, SQLITE_ERROR, no such table: member`. Never a value. */
	readonly kind: string;
	/** Eight hex characters, made here, in the message and in the log line. */
	readonly reference: string;

	constructor(kind: string, reference: string) {
		super(`A database query failed (reference ${reference})`);
		this.name = "DatabaseError";
		this.kind = kind;
		this.reference = reference;
	}
}

/**
 * What SQLite may be quoted on: a constraint or a missing table or column, and the names it gives,
 * which are the schema's. Anything else it says is left out.
 */
const QUOTABLE = [
	/\b(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed(?:: [\w.]+(?:, [\w.]+)*)?/,
	/\bno such (?:table|column): [\w.]+/,
];

/**
 * The kind of failure, from D1's words: its code, SQLite's, the name a passing failure is logged
 * under, and what `QUOTABLE` allows. Never the words themselves: `Failed to parse body as JSON,
 * got: …` can carry what a row held.
 */
function kindOf(cause: unknown): string {
	const said = cause instanceof Error ? cause.message : "";
	const parts = [
		/^D1_[A-Z_]+/.exec(said)?.[0],
		/\bSQLITE_[A-Z_]+/.exec(said)?.[0],
		passing(cause),
		QUOTABLE.map((pattern) => pattern.exec(said)?.[0]).find(Boolean),
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "unknown";
}

function newReference(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Makes the error for what D1 said, and logs it once, which is where its kind can be read. */
function failed(cause: unknown): DatabaseError {
	const error = new DatabaseError(kindOf(cause), newReference());
	console.error(`d1: a query failed (${error.kind}), reference ${error.reference}`);
	return error;
}

/** Drizzle's error for a failed query, by its class or by what it carries. */
function isQueryError(error: unknown): error is Error {
	if (error instanceof DrizzleQueryError) return true;
	return error instanceof Error && "query" in error && "params" in error;
}

/** How a prepared query is sent. `execute` goes through one of these. */
const SENDS = ["run", "all", "get", "values"] as const;

type Method = (...args: unknown[]) => unknown;

/** The parts of Drizzle's session this reaches for. It does not export their types. */
interface Session {
	prepareQuery: Method;
	batch: Method;
}

function isSession(session: unknown): session is Session {
	if (typeof session !== "object" || session === null) return false;
	return (
		typeof (session as Partial<Session>).prepareQuery === "function" &&
		typeof (session as Partial<Session>).batch === "function"
	);
}

/**
 * The database, with every failed query thrown as a `DatabaseError`.
 *
 * Drizzle makes its error inside the query, above the D1 binding and below everything that
 * awaits one, so the only place that sees all of them is where its session prepares a query:
 * every builder, `db.query`, `db.run` and a transaction go through `prepareQuery`. A batch is
 * sent whole, and fails in D1's words.
 *
 * The session is not part of Drizzle's public types. If a version no longer has it this throws,
 * at the first request and in every test, rather than leave the statements in the errors again.
 */
export function withoutStatements<Db extends object>(db: Db): Db {
	const session: unknown = Reflect.get(db, "session");
	if (!isSession(session)) {
		throw new Error(
			"Drizzle's session cannot be reached, so a failed query would carry its values",
		);
	}
	const { prepareQuery, batch } = session;

	session.prepareQuery = (...given: unknown[]) => {
		const prepared = Reflect.apply(prepareQuery, session, given) as Record<string, unknown>;
		for (const send of SENDS) {
			const original = prepared[send];
			if (typeof original !== "function") continue;
			prepared[send] = async (...args: unknown[]) => {
				try {
					return await Reflect.apply(original, prepared, args);
				} catch (error) {
					// `all` and `get` may go through `values`, which has made the error by then.
					throw isQueryError(error) ? failed(error.cause) : error;
				}
			};
		}
		return prepared;
	};

	session.batch = async (...given: unknown[]) => {
		try {
			return await Reflect.apply(batch, session, given);
		} catch (error) {
			throw error instanceof DatabaseError ? error : failed(error);
		}
	};

	return db;
}
