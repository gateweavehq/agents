/** How many times a read is sent before its failure is the answer. */
export const READ_ATTEMPTS = 3;

/** How long to wait before the second and the third, in milliseconds. */
const WAITS = [25, 100];

const READ = /^\s*select\b/i;

/** The four ways a statement is sent. `bind` only makes another statement. */
const SENDS: ReadonlySet<PropertyKey> = new Set(["all", "raw", "first", "run"]);

/**
 * A statement SQLite itself refused, which it would refuse again. D1 ends such a message with
 * SQLite's code, as in `no such table: user: SQLITE_ERROR`.
 */
function refusedBySqlite(error: unknown): boolean {
	return error instanceof Error && error.message.includes("SQLITE_");
}

async function sendAgain<Answer>(send: () => Promise<Answer>): Promise<Answer> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await send();
		} catch (error) {
			if (attempt >= READ_ATTEMPTS || refusedBySqlite(error)) throw error;
			// D1's own message, which names no value: a statement's values travel apart from it.
			const reason = error instanceof Error ? error.message.slice(0, 200) : "unknown";
			console.warn(`d1: a read failed and is sent again (attempt ${attempt}): ${reason}`);
			await new Promise((resolve) => setTimeout(resolve, WAITS[attempt - 1] ?? 100));
		}
	}
}

/**
 * The database, with a read that fails sent again before anyone is told. D1 can fail for a moment
 * (its object restarting, a connection lost), and so can the local runtime under load, which is how
 * this was found (AGT-131): one failed read of a session made a signed-in person's page a 500.
 * Asking again costs a read nothing. D1 retries reads too where it can tell the failure is passing;
 * this covers what is left, and local runs, where nothing retries.
 *
 * Only a single `select` is sent again. A write may have happened although its answer was lost,
 * and a batch may hold writes, so their failures stay the caller's to handle.
 */
export function retryingReads(d1: D1Database): D1Database {
	// A deployment without a database serves nothing (`notSetUp` in server.ts): nothing to wrap.
	if (!d1) return d1;
	// `batch` reads its statements' own fields, so it gets the ones D1 made.
	const made = new WeakMap<object, D1PreparedStatement>();

	function watched(statement: D1PreparedStatement, read: boolean): D1PreparedStatement {
		const proxy = new Proxy(statement, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key === "bind") {
					return (...values: unknown[]) =>
						watched(Reflect.apply(value, target, values) as D1PreparedStatement, read);
				}
				if (read && SENDS.has(key)) {
					return (...args: unknown[]) =>
						sendAgain(() => Reflect.apply(value, target, args) as Promise<unknown>);
				}
				return value.bind(target);
			},
		});
		made.set(proxy, statement);
		return proxy;
	}

	return new Proxy(d1, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key === "prepare") {
				return (query: string) =>
					watched(Reflect.apply(value, target, [query]) as D1PreparedStatement, READ.test(query));
			}
			if (key === "batch") {
				return (statements: D1PreparedStatement[]) =>
					Reflect.apply(value, target, [
						statements.map((statement) => made.get(statement) ?? statement),
					]) as unknown;
			}
			return value.bind(target);
		},
	});
}
