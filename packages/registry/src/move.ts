/**
 * Moving a workspace's Durable Objects to the same names somewhere else, such as one of
 * Cloudflare's jurisdictions (docs/architecture.md, "Where a workspace lives"). Cloudflare doesn't
 * move an object, and the same name in another jurisdiction is another, empty one, so the app
 * copies each across: the workspace's registry and every conversation it lists
 * ({@link moveWorkspace}).
 *
 * 1. The old registry freezes first, so no turn begins and no conversation opens; a workspace with
 *    a turn under way waits for another day. Each conversation then freezes as it is copied.
 *    Triggers refuse every write to a frozen object's tables, and it takes no sockets and runs no
 *    alarm. A freeze lapses after {@link MOVE_FREEZE_MS}, so a move that dies half way leaves the
 *    workspace where it was, working again by then. It holds through a restart: an object left
 *    idle while the rest of its workspace is copied may be evicted, and must not take writes the
 *    copy has missed when it wakes.
 * 2. Each new object is emptied, makes the tables it lacks as the old one made them, and takes the
 *    old one's rows a page at a time, rowids too, then its key-value pairs.
 * 3. Both count their rows and keys and hash them, and the two must agree.
 * 4. The old registry seals, which commits the move: it refuses everything from then on. The old
 *    conversations seal too, and every old object keeps its data until it is destroyed. The new
 *    ones start, each with its old one's alarm, and the app records where the workspace is.
 */

/** How long a freeze holds. A move takes seconds; this only bounds one that died half way. */
export const MOVE_FREEZE_MS = 10 * 60 * 1000;

/** About how many characters a page of rows carries: well under what one RPC call can take. */
const PAGE_CHARS = 4_000_000;

/** Key-value pairs a page carries. A value is at most 128 KiB; most are a few bytes. */
const KEYS_PER_PAGE = 100;

/** Why a write fails in a frozen or sealed object, as its triggers raise it. */
export const MOVING_MESSAGE = "This workspace is moving to another place. Try again in a minute.";

// Where a move stands, in the object's key-value storage. The copy leaves these keys out, so none
// of this reaches the other object.
const FREEZE = "move.freeze";
const SEALED = "move.sealed";
const IMPORT = "move.import";
const FROM = "move.from";
const MOVE_KEYS: readonly string[] = [FREEZE, SEALED, IMPORT, FROM];

const BLOCK = "_move_block_";

interface Freeze {
	token: string;
	until: number;
	/** Where the workspace is going, as the app names it. */
	to: string;
}

interface Sealed {
	to: string;
	at: number;
}

interface Import {
	token: string;
	/** The old object's alarm, which the new one sets once it starts. */
	alarm: number | null;
}

export interface MoveTable {
	name: string;
	/** Its columns, without hidden ones. Every row carries its rowid first, then these in order. */
	columns: string[];
	rows: number;
	/** How the old object made the table and its indexes, for a new one that has yet to. */
	create: string[];
}

/** What a frozen object holds, which the copy has to match. */
export interface MoveManifest {
	tables: MoveTable[];
	/** How many key-value pairs it holds, besides a move's own. */
	keys: number;
	/** When its alarm was due, if it had one. */
	alarm: number | null;
}

export type MoveOut =
	| { frozen: true; manifest: MoveManifest }
	/** It moved before: sealed, holding the data it had then. */
	| { frozen: false; sealedTo: string };

/**
 * Where the next page starts: a table, by its place in the manifest, and the rowid read last, or
 * for a table without rowids how many of its rows were read.
 */
export interface MoveCursor {
	table: number;
	after: number | null;
}

export interface MoveRows {
	table: string;
	/** The columns of `rows`, after the rowid: the manifest's. */
	columns: string[];
	/** Each row's rowid, unless its table has none, then its columns' values. */
	rows: SqlStorageValue[][];
}

export interface MovePage {
	tables: MoveRows[];
	next: MoveCursor | null;
}

/** A page of key-value pairs, with the key to read on from, if there are more. */
export interface MoveKeys {
	entries: [string, unknown][];
	next: string | null;
}

/** Where a move leaves an object, as it starts up. */
export type MoveState = "sealed" | "importing" | "frozen" | null;

interface CopiedTable {
	name: string;
	virtual: boolean;
	columns: string[];
	create: string[];
	/** Whether its rows have rowids, which travel with them; a table made WITHOUT ROWID has none. */
	rowid: boolean;
	/** The order its rows are read and hashed in: by rowid, or by primary key. */
	order: string;
}

function quoteName(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The tables a move copies: the object's own, and its full-text indexes by their content, whose
 * shadow tables follow. Drizzle's record of migrations stays, as both ends ran the same ones.
 */
function copiedTables(storage: DurableObjectStorage): CopiedTable[] {
	const list = storage.sql
		.exec<{ name: string; type: string; wr: number }>("PRAGMA main.table_list")
		.toArray()
		.filter(
			({ name, type }) =>
				(type === "table" || type === "virtual") &&
				!name.startsWith("sqlite_") &&
				!name.startsWith("_cf_") &&
				!name.startsWith("__cf_") &&
				name !== "__drizzle_migrations",
		);
	const made = new Map<string, string[]>();
	for (const row of storage.sql
		.exec<{ type: string; name: string; tbl_name: string; sql: string | null }>(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC, name",
		)
		.toArray()) {
		const statements = made.get(row.tbl_name) ?? [];
		statements.push(row.sql as string);
		made.set(row.tbl_name, statements);
	}
	const tables = list.map(({ name, type, wr }) => {
		const columns = storage.sql
			.exec<{ name: string; hidden: number; pk: number }>(`PRAGMA table_xinfo(${quoteName(name)})`)
			.toArray()
			.filter((column) => column.hidden === 0);
		const key = columns
			.filter((column) => column.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((column) => quoteName(column.name));
		return {
			name,
			virtual: type === "virtual",
			columns: columns.map((column) => column.name),
			create: made.get(name) ?? [],
			rowid: wr !== 1,
			order: wr === 1 ? key.join(", ") : "rowid",
		};
	});
	return parentsFirst(storage, tables);
}

/**
 * Orders tables so that each comes after the tables it refers to, as rows are written a page at a
 * time and each page's foreign keys are checked when it commits. Then by name, so both objects
 * agree. A table that refers to itself would still fail, if its rows came over in two pages.
 */
function parentsFirst(storage: DurableObjectStorage, tables: CopiedTable[]): CopiedTable[] {
	const names = new Set(tables.map((table) => table.name));
	const parents = new Map(
		tables.map((table) => [
			table.name,
			new Set(
				table.virtual
					? []
					: storage.sql
							.exec<{ table: string }>(`PRAGMA foreign_key_list(${quoteName(table.name)})`)
							.toArray()
							.map((key) => key.table)
							.filter((parent) => parent !== table.name && names.has(parent)),
			),
		]),
	);
	const ordered: CopiedTable[] = [];
	const placed = new Set<string>();
	const waiting = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	while (waiting.length > 0) {
		const index = waiting.findIndex((table) =>
			[...(parents.get(table.name) ?? [])].every((parent) => placed.has(parent)),
		);
		// Tables that refer to each other in a ring: take them in name order.
		const [next] = waiting.splice(index === -1 ? 0 : index, 1);
		if (!next) break;
		ordered.push(next);
		placed.add(next.name);
	}
	return ordered;
}

function count(storage: DurableObjectStorage, table: string): number {
	return storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quoteName(table)}`).one().n;
}

/** The object's key-value pairs, besides a move's own. */
function* ownEntries(
	storage: DurableObjectStorage,
	options: SyncKvListOptions = {},
): Generator<[string, unknown]> {
	for (const [key, value] of storage.kv.list(options)) {
		if (!MOVE_KEYS.includes(key)) yield [key, value];
	}
}

function keyCount(storage: DurableObjectStorage): number {
	let keys = 0;
	for (const _ of ownEntries(storage)) keys++;
	return keys;
}

function sameColumns(a: string[], b: string[]): boolean {
	return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

async function manifestOf(storage: DurableObjectStorage): Promise<MoveManifest> {
	return {
		tables: copiedTables(storage).map(({ name, columns, create }) => ({
			name,
			columns,
			rows: count(storage, name),
			create,
		})),
		keys: keyCount(storage),
		alarm: await storage.getAlarm(),
	};
}

function dropBlocks(storage: DurableObjectStorage): void {
	const triggers = storage.sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB ?",
			`${BLOCK}*`,
		)
		.toArray();
	for (const { name } of triggers) storage.sql.exec(`DROP TRIGGER ${quoteName(name)}`);
}

// The old object.

/**
 * Freezes the object for a move to `to`, and says what it holds. One sealed by an earlier move
 * says so instead. The same token freezes it again; another one waits for the first move's freeze
 * to end.
 */
export async function freezeForMove(
	storage: DurableObjectStorage,
	token: string,
	to: string,
	now: number,
): Promise<MoveOut> {
	const sealed = storage.kv.get<Sealed>(SEALED);
	if (sealed) return { frozen: false, sealedTo: sealed.to };
	const freeze = storage.kv.get<Freeze>(FREEZE);
	if (freeze && freeze.token !== token && freeze.until > now) {
		throw new Error("Another move of this workspace is under way.");
	}
	storage.transactionSync(() => {
		dropBlocks(storage);
		const message = MOVING_MESSAGE.replaceAll("'", "''");
		for (const table of copiedTables(storage)) {
			if (table.virtual) continue;
			for (const event of ["INSERT", "UPDATE", "DELETE"]) {
				storage.sql.exec(
					`CREATE TRIGGER ${quoteName(`${BLOCK}${table.name}_${event.toLowerCase()}`)}
					BEFORE ${event} ON ${quoteName(table.name)}
					BEGIN SELECT RAISE(ABORT, '${message}'); END`,
				);
			}
		}
		storage.kv.put(FREEZE, { token, until: now + MOVE_FREEZE_MS, to } satisfies Freeze);
	});
	return { frozen: true, manifest: await manifestOf(storage) };
}

/** Whether a move has the object frozen now. */
export function isFrozen(storage: DurableObjectStorage, now: number): boolean {
	const freeze = storage.kv.get<Freeze>(FREEZE);
	return freeze !== undefined && freeze.until > now;
}

/** When the freeze on the object ends, if there is one: it lapses then. */
export function freezeEnds(storage: DurableObjectStorage): number | null {
	return storage.kv.get<Freeze>(FREEZE)?.until ?? null;
}

function checkFreeze(storage: DurableObjectStorage, token: string, now: number): Freeze {
	const freeze = storage.kv.get<Freeze>(FREEZE);
	if (!freeze || freeze.token !== token || freeze.until <= now) {
		throw new Error("The move was interrupted: the workspace is no longer frozen for it.");
	}
	return freeze;
}

/** How a move's freeze ended when it gave up: thawed, sealed after all, or none to end. */
export type Thawed = "thawed" | "sealed" | "none";

/** Ends a move's freeze when it gives up, unless the object was sealed after all. */
export function thawAfterMove(storage: DurableObjectStorage, token: string): Thawed {
	if (storage.kv.get(SEALED) !== undefined) return "sealed";
	return thaw(storage, token) ? "thawed" : "none";
}

/** Ends a freeze: the move's, given its token, or whichever there is. Writes work again. */
export function thaw(storage: DurableObjectStorage, token?: string): boolean {
	const freeze = storage.kv.get<Freeze>(FREEZE);
	if (!freeze || (token !== undefined && freeze.token !== token)) return false;
	storage.transactionSync(() => {
		dropBlocks(storage);
		storage.kv.delete(FREEZE);
	});
	return true;
}

/**
 * The next page of the frozen object's rows, from `cursor` on: whole rows, about `chars` of them,
 * and at least one.
 */
export function readForMove(
	storage: DurableObjectStorage,
	token: string,
	cursor: MoveCursor,
	now: number,
	chars = PAGE_CHARS,
): MovePage {
	checkFreeze(storage, token, now);
	const tables = copiedTables(storage);
	const page: MoveRows[] = [];
	let left = Math.min(Math.max(1, chars), PAGE_CHARS);
	for (let index = cursor.table; index < tables.length; index++) {
		const table = tables[index];
		if (!table) break;
		const after = index === cursor.table ? cursor.after : null;
		const columns = [...(table.rowid ? ["rowid"] : []), ...table.columns].map(quoteName).join(", ");
		// A number is bound as a real, and a full-text table can drop a rowid constraint that is not
		// an integer, hence the cast. A table without rowids is read on from an offset, which holds
		// still while the object is frozen.
		const where =
			after === null
				? ` ORDER BY ${table.order}`
				: table.rowid
					? " WHERE rowid > CAST(? AS INTEGER) ORDER BY rowid"
					: ` ORDER BY ${table.order} LIMIT -1 OFFSET CAST(? AS INTEGER)`;
		const query = `SELECT ${columns} FROM ${quoteName(table.name)}${where}`;
		const rows: SqlStorageValue[][] = [];
		let last = after;
		for (const row of storage.sql.exec(query, ...(after === null ? [] : [after])).raw()) {
			rows.push(row);
			last = table.rowid ? (row[0] as number) : (last ?? 0) + 1;
			left -= size(row);
			if (left <= 0) break;
		}
		if (rows.length > 0) page.push({ table: table.name, columns: table.columns, rows });
		if (left <= 0) return { tables: page, next: { table: index, after: last } };
	}
	return { tables: page, next: null };
}

function size(row: SqlStorageValue[]): number {
	let chars = 0;
	for (const value of row) {
		if (typeof value === "string") chars += value.length + 2;
		else if (value instanceof ArrayBuffer) chars += value.byteLength;
		else chars += 8;
	}
	return chars;
}

/** The next page of the frozen object's key-value pairs, after the key `after`. */
export function readKeysForMove(
	storage: DurableObjectStorage,
	token: string,
	after: string | null,
	now: number,
): MoveKeys {
	checkFreeze(storage, token, now);
	const entries: [string, unknown][] = [];
	let last: string | null = null;
	// Listed one more than a page, to know whether another follows. A move's own keys may be among
	// them, so the page is cut by what was listed, not by what was kept.
	const limit = KEYS_PER_PAGE + 1;
	const listed = [...storage.kv.list(after === null ? { limit } : { startAfter: after, limit })];
	for (const [key, value] of listed.slice(0, KEYS_PER_PAGE)) {
		last = key;
		if (!MOVE_KEYS.includes(key)) entries.push([key, value]);
	}
	return { entries, next: listed.length > KEYS_PER_PAGE ? last : null };
}

/**
 * Seals the object once its copy is checked: it refuses everything from then on, and keeps its
 * data until it is destroyed. Its alarm goes, as its work is the new object's now. Without
 * `keepBlocks`, its tables take writes again: an object that guards every way in itself, and whose
 * own start-up may write, stays able to start.
 */
export async function sealForMove(
	storage: DurableObjectStorage,
	token: string | null,
	to: string,
	now: number,
	{ keepBlocks = true }: { keepBlocks?: boolean } = {},
): Promise<void> {
	if (token !== null) checkFreeze(storage, token, now);
	storage.transactionSync(() => {
		if (!keepBlocks) dropBlocks(storage);
		storage.kv.put(SEALED, { to, at: now } satisfies Sealed);
		storage.kv.delete(FREEZE);
	});
	await storage.deleteAlarm();
}

/** Where a sealed object's workspace went, or null while it has not moved away. */
export function sealedTo(storage: DurableObjectStorage): string | null {
	return storage.kv.get<Sealed>(SEALED)?.to ?? null;
}

// The new object.

/**
 * Whether this object may be emptied for a move into it: it is `fresh`, as its class judges, or a
 * move's earlier copy, or an object whose workspace has since moved away. One moving out never is.
 */
export function mayImport(storage: DurableObjectStorage, fresh: boolean): boolean {
	if (storage.kv.get(FREEZE) !== undefined) return false;
	return storage.kv.get(IMPORT) !== undefined || storage.kv.get(SEALED) !== undefined || fresh;
}

/**
 * Readies an emptied object for the rows in `manifest`. It makes the tables it lacks as the old
 * object made them, as some are made on first use; those it has must have the same columns.
 */
export async function beginImport(
	storage: DurableObjectStorage,
	token: string,
	manifest: MoveManifest,
): Promise<void> {
	let own = new Map(copiedTables(storage).map((table) => [table.name, table]));
	const lacking = manifest.tables.filter((table) => !own.has(table.name));
	if (lacking.length > 0) {
		storage.transactionSync(() => {
			for (const table of lacking) for (const sql of table.create) storage.sql.exec(sql);
		});
		own = new Map(copiedTables(storage).map((table) => [table.name, table]));
	}
	const differ = manifest.tables
		.filter((table) => !sameColumns(own.get(table.name)?.columns ?? [], table.columns))
		.map((table) => table.name);
	if (differ.length > 0) {
		throw new Error(
			`The two objects' tables differ: ${differ.join(", ")}. Deploy one version first.`,
		);
	}
	storage.transactionSync(() => {
		for (const name of own.keys()) storage.sql.exec(`DELETE FROM ${quoteName(name)}`);
		for (const [key] of [...ownEntries(storage)]) storage.kv.delete(key);
		storage.kv.delete(SEALED);
		storage.kv.delete(FROM);
		storage.kv.put(IMPORT, { token, alarm: manifest.alarm } satisfies Import);
	});
	await storage.deleteAlarm();
}

function checkImport(storage: DurableObjectStorage, token: string): void {
	if (storage.kv.get<Import>(IMPORT)?.token !== token) {
		throw new Error("This object is not taking the rows of that move.");
	}
}

/** Writes a page of rows, in one transaction. */
export function writeForMove(storage: DurableObjectStorage, token: string, page: MoveRows[]): void {
	checkImport(storage, token);
	const tables = new Map(copiedTables(storage).map((table) => [table.name, table]));
	storage.transactionSync(() => {
		storage.sql.exec("PRAGMA defer_foreign_keys = ON");
		for (const { table: name, columns, rows } of page) {
			const table = tables.get(name);
			if (!table) throw new Error(`No table ${name} here.`);
			if (!sameColumns(table.columns, columns)) throw new Error(`The columns of ${name} differ.`);
			const rowid = table.rowid ? ["rowid"] : [];
			const names = [...rowid, ...columns].map(quoteName).join(", ");
			// A number is bound as a real; each column's affinity makes it what it was, and the
			// rowid has none.
			const values = [...rowid.map(() => "CAST(? AS INTEGER)"), ...columns.map(() => "?")];
			const insert = `INSERT INTO ${quoteName(name)} (${names}) VALUES (${values.join(", ")})`;
			for (const row of rows) {
				if (row.length !== values.length) throw new Error(`A row of ${name} is cut.`);
				storage.sql.exec(insert, ...row);
			}
		}
	});
}

/** Writes a page of key-value pairs. */
export function writeKeysForMove(
	storage: DurableObjectStorage,
	token: string,
	entries: [string, unknown][],
): void {
	checkImport(storage, token);
	storage.transactionSync(() => {
		for (const [key, value] of entries) {
			if (MOVE_KEYS.includes(key)) throw new Error(`The key ${key} is a move's own.`);
			storage.kv.put(key, value);
		}
	});
}

/** Checks the copy against the manifest: every table's rows, its foreign keys and its keys. */
export function checkCopy(
	storage: DurableObjectStorage,
	token: string,
	manifest: MoveManifest,
): void {
	checkImport(storage, token);
	const short = manifest.tables
		.filter((table) => count(storage, table.name) !== table.rows)
		.map((table) => table.name);
	if (short.length > 0) throw new Error(`The copy's row counts differ in ${short.join(", ")}.`);
	if (storage.sql.exec("PRAGMA foreign_key_check").toArray().length > 0) {
		throw new Error("The copy has rows whose references are missing.");
	}
	if (keyCount(storage) !== manifest.keys) {
		throw new Error("The copy's key-value pairs differ in number.");
	}
}

/**
 * Ends a move into this object, which holds the workspace from now on and came `from` there. The
 * old object's alarm is set here, or now if it is past. A call for a move this object took in
 * before does nothing more.
 */
export async function endImport(
	storage: DurableObjectStorage,
	from: string,
	now: number,
): Promise<void> {
	const taking = storage.kv.get<Import>(IMPORT);
	if (!taking) {
		if (storage.kv.get(FROM) === undefined) {
			throw new Error("This object doesn't hold a workspace that moved.");
		}
		return;
	}
	storage.transactionSync(() => {
		storage.kv.delete(IMPORT);
		storage.kv.put(FROM, from);
	});
	if (taking.alarm !== null) await storage.setAlarm(Math.max(taking.alarm, now));
}

/** Where this object's workspace was before it moved here, "" for outside any jurisdiction. */
export function movedFrom(storage: DurableObjectStorage): string | null {
	return storage.kv.get<string>(FROM) ?? null;
}

/**
 * Settles where a move left the object as it starts: sealed, half filled, or frozen, as a freeze
 * outlives a restart until it lapses. One that lapsed ends here.
 */
export function moveStateAtStart(storage: DurableObjectStorage, now: number): MoveState {
	if (storage.kv.get(SEALED) !== undefined) return "sealed";
	if (storage.kv.get(IMPORT) !== undefined) return "importing";
	if (isFrozen(storage, now)) return "frozen";
	thaw(storage);
	return null;
}

/** Where a move has an object, read from its storage. */
export function moveStateNow(
	storage: DurableObjectStorage,
	now: number,
): "frozen" | "sealed" | "importing" | null {
	if (storage.kv.get(SEALED) !== undefined) return "sealed";
	if (storage.kv.get(IMPORT) !== undefined) return "importing";
	return isFrozen(storage, now) ? "frozen" : null;
}

/** The name a digest gives the key-value pairs, which no table can have, being no SQL name. */
const KEYS_DIGEST = " keys";

/**
 * A hash of each copied table's rows, rowid first where they have one, each value as SQLite quotes it, so that a value
 * that changed type differs too, and one of the key-value pairs. Columns go in name order, which
 * both ends share whatever order they were added in. Hashed a chunk at a time, each chunk with the
 * hash before it, so a large table needn't fit in memory.
 */
export async function digestForMove(
	storage: DurableObjectStorage,
): Promise<Record<string, string>> {
	const digests: Record<string, string> = {};
	for (const table of copiedTables(storage)) {
		const row = [...(table.rowid ? ["rowid"] : []), ...[...table.columns].sort()].map(
			(column) => `quote(${quoteName(column)})`,
		);
		const hash = new ChainedHash();
		for (const { line } of storage.sql.exec<{ line: string }>(
			`SELECT ${row.join(" || ',' || ")} AS line FROM ${quoteName(table.name)} ORDER BY ${table.order}`,
		)) {
			await hash.add(line);
		}
		digests[table.name] = await hash.end();
	}
	const keys = new ChainedHash();
	for (const [key, value] of ownEntries(storage)) await keys.add(`${key}=${describe(value)}`);
	digests[KEYS_DIGEST] = await keys.end();
	return digests;
}

class ChainedHash {
	#hash = "";
	#chunk = "";
	readonly #encoder = new TextEncoder();

	async add(line: string): Promise<void> {
		this.#chunk += `${line}\n`;
		if (this.#chunk.length > 1_000_000) await this.#flush();
	}

	async end(): Promise<string> {
		await this.#flush();
		return this.#hash;
	}

	async #flush(): Promise<void> {
		const bytes = this.#encoder.encode(`${this.#hash}\n${this.#chunk}`);
		this.#hash = toHex(await crypto.subtle.digest("SHA-256", bytes));
		this.#chunk = "";
	}
}

/** A stored value as text, the same for equal values: maps and sets in their order, as copied. */
function describe(value: unknown): string {
	if (value === null || value === undefined || typeof value === "boolean") return String(value);
	if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "string") return JSON.stringify(value);
	if (value instanceof Date) return `Date(${value.getTime()})`;
	if (value instanceof ArrayBuffer) return `Bytes(${toHex(value)})`;
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return `${value.constructor.name}(${toHex(bytes)})`;
	}
	if (value instanceof Map) {
		return `Map(${[...value].map(([k, v]) => `${describe(k)}=>${describe(v)}`).join(",")})`;
	}
	if (value instanceof Set) return `Set(${[...value].map(describe).join(",")})`;
	if (Array.isArray(value)) return `[${value.map(describe).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const fields = Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${describe(record[key])}`);
		return `{${fields.join(",")}}`;
	}
	return String(value);
}

function toHex(buffer: ArrayBuffer | Uint8Array): string {
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The app's side.

/** An old object's calls in a move. */
export interface MoveSource {
	moveOut(token: string, to: string): Promise<MoveOut>;
	moveRead(token: string, cursor: MoveCursor, chars?: number): Promise<MovePage>;
	moveReadKeys(token: string, after: string | null): Promise<MoveKeys>;
	moveDigest(): Promise<Record<string, string>>;
	/** Seals it for the move with `token`, or for one already committed with null. */
	moveSeal(token: string | null, to: string): Promise<void>;
	moveThaw(token: string): Promise<Thawed>;
}

/** A new object's calls in a move. */
export interface MoveTarget {
	moveIn(token: string, manifest: MoveManifest): Promise<void>;
	moveWrite(token: string, page: MoveRows[]): Promise<void>;
	moveWriteKeys(token: string, entries: [string, unknown][]): Promise<void>;
	moveCheck(token: string, manifest: MoveManifest): Promise<void>;
	moveDigest(): Promise<Record<string, string>>;
	/** Starts it with the workspace, which came from `from`. */
	moveStart(from: string): Promise<void>;
}

/** What the old registry says as a move begins: what the workspace holds, or why it can't move. */
export type RegistryMoveOut =
	| { frozen: true; manifest: MoveManifest; conversations: string[] }
	| { frozen: false; sealedTo: string; conversations: string[] }
	/** Turns are under way, which a move would cut short: it waits for another day. */
	| { busy: number };

/** The old registry's calls in a move: its moveOut also lists the conversations. */
export interface RegistryMoveSource extends Omit<MoveSource, "moveOut"> {
	moveOut(token: string, to: string): Promise<RegistryMoveOut>;
}

export interface WorkspaceMove {
	registry: { from: RegistryMoveSource; to: MoveTarget };
	/** A conversation's object where it is and where it goes. */
	conversation(id: string): { from: MoveSource; to: MoveTarget };
	/** Copies what else goes with a conversation, such as what its sandbox keeps. */
	alongside?(id: string): Promise<void>;
	/** Where the workspace was, as the app names it: "" for outside any jurisdiction. */
	from: string;
	/** Where the workspace is going, as the app names it: kept by the old objects once sealed. */
	to: string;
	/** Notes where the workspace is now, so the app reaches it there. */
	record(): Promise<void>;
}

export type WorkspaceMoveReport =
	| {
			moved: true;
			conversations: number;
			rows: number;
			/** True when an earlier move had committed it, and this one only finished it. */
			finished: boolean;
	  }
	| { moved: false; busy: number };

/** How many times the last steps are tried, as the workspace is out of reach between them. */
const LAST_STEP_TRIES = 5;

/** How many conversations are copied at once. */
const CONVERSATIONS_AT_ONCE = 4;

/**
 * Moves a workspace's registry and conversations, then has `record` note where it is now. Throws
 * if the workspace stays where it was, frozen no more. Once the old registry is sealed, the
 * workspace is out of reach until `record` has run: a move that dies there is finished by the
 * next, which finds it sealed.
 */
export async function moveWorkspace(
	move: WorkspaceMove,
	{
		pageChars,
		retryMs = 1000,
	}: {
		/** Smaller pages than usual, for tests. */
		pageChars?: number;
		/** The first wait before trying a last step again, doubling each time; shorter in tests. */
		retryMs?: number;
	} = {},
): Promise<WorkspaceMoveReport> {
	const token = crypto.randomUUID();
	const out = await move.registry.from.moveOut(token, move.to);
	if ("busy" in out) return { moved: false, busy: out.busy };
	if (!out.frozen) {
		if (out.sealedTo !== move.to) {
			throw new Error(`The workspace moved before, to ${out.sealedTo || "no jurisdiction"}.`);
		}
		await finish(move, null, out.conversations, retryMs);
		return { moved: true, conversations: out.conversations.length, rows: 0, finished: true };
	}
	const frozen: MoveSource[] = [];
	let rows = 0;
	try {
		await eachAtMost(CONVERSATIONS_AT_ONCE, out.conversations, async (id) => {
			const { from, to } = move.conversation(id);
			const conversation = await from.moveOut(token, move.to);
			if (!conversation.frozen) {
				throw new Error(`Conversation ${id} moved before, to ${conversation.sealedTo}.`);
			}
			frozen.push(from);
			rows += await copy(from, to, token, conversation.manifest, pageChars);
			await move.alongside?.(id);
		});
		rows += await copy(move.registry.from, move.registry.to, token, out.manifest, pageChars);
		// The commit: from here the workspace is the new objects'.
		await move.registry.from.moveSeal(token, move.to);
	} catch (error) {
		// If these fail too, the freezes lapse on their own. A seal whose answer was lost took effect.
		const thawed = await move.registry.from.moveThaw(token).catch(() => "none" as const);
		await Promise.all(frozen.map((from) => from.moveThaw(token).catch(() => "none")));
		if (thawed !== "sealed") throw error;
	}
	await finish(move, token, out.conversations, retryMs);
	return { moved: true, conversations: out.conversations.length, rows, finished: false };
}

/** Copies one object into another and checks the copy. Returns how many rows went. */
async function copy(
	from: Omit<MoveSource, "moveOut">,
	to: MoveTarget,
	token: string,
	manifest: MoveManifest,
	pageChars: number | undefined,
): Promise<number> {
	await to.moveIn(token, manifest);
	let cursor: MoveCursor | null = { table: 0, after: null };
	while (cursor) {
		const page: MovePage = await from.moveRead(token, cursor, pageChars);
		if (page.tables.length > 0) await to.moveWrite(token, page.tables);
		cursor = page.next;
	}
	let after: string | null = null;
	do {
		const keys: MoveKeys = await from.moveReadKeys(token, after);
		if (keys.entries.length > 0) await to.moveWriteKeys(token, keys.entries);
		after = keys.next;
	} while (after !== null);
	await to.moveCheck(token, manifest);
	const [theirs, ours] = await Promise.all([from.moveDigest(), to.moveDigest()]);
	const differ = [...new Set([...Object.keys(theirs), ...Object.keys(ours)])].filter(
		(name) => theirs[name] !== ours[name],
	);
	if (differ.length > 0) throw new Error(`The copy differs in ${differ.join(", ").trim()}.`);
	return manifest.tables.reduce((sum, table) => sum + table.rows, 0);
}

/**
 * The steps after the commit: the old conversations seal, the new objects start, and the app
 * records the move. Each is tried again, as the workspace is out of reach until they are done.
 */
async function finish(
	move: WorkspaceMove,
	token: string | null,
	conversations: string[],
	retryMs: number,
): Promise<void> {
	await eachAtMost(CONVERSATIONS_AT_ONCE, conversations, async (id) => {
		const { from, to } = move.conversation(id);
		await retry(() => from.moveSeal(token, move.to), retryMs);
		await retry(() => to.moveStart(move.from), retryMs);
	});
	await retry(() => move.registry.to.moveStart(move.from), retryMs);
	await retry(() => move.record(), retryMs);
}

async function eachAtMost<T>(
	limit: number,
	items: T[],
	work: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	let failure: { error: unknown } | null = null;
	const worker = async () => {
		while (failure === null) {
			const item = queue.shift();
			if (item === undefined) return;
			try {
				await work(item);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failure !== null) throw (failure as { error: unknown }).error;
}

async function retry(step: () => Promise<void>, firstWaitMs: number): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await step();
			return;
		} catch (error) {
			if (attempt + 1 >= LAST_STEP_TRIES) throw error;
			await new Promise((resolve) => setTimeout(resolve, firstWaitMs * 2 ** attempt));
		}
	}
}
