/**
 * Where the registry stores what `secrets.ts` seals: every column that holds a sealed value. The
 * registry asks them two things: which of the server's keys its values were sealed under, and to
 * put a value sealed again in the place of the one it was opened from.
 *
 * A new sealed column goes on this list; a test compares it with the schema's columns named
 * `sealed…`.
 */
import { DERIVED, EXPLICIT } from "./secrets";

export const SEALED_COLUMNS = [
	["provider_keys", "sealed"],
	["env_secrets", "sealed"],
	["triggers", "sealed"],
	["telemetry", "sealed_headers"],
	["mcp_oauth", "sealed_client"],
	["mcp_oauth", "sealed_verifier"],
	["mcp_oauth", "sealed_tokens"],
	["track_connections", "sealed_verifier"],
	["gitlab_connections", "sealed_token"],
	["gitlab_connections", "sealed_webhook_secret"],
] as const;

/** How many of the workspace's sealed values each of the server's keys sealed. */
export interface SealedCounts {
	/** Sealed with a `SECRETS_KEY`. */
	explicit: number;
	/** Sealed with the key derived from `BETTER_AUTH_SECRET`. */
	derived: number;
}

export function sealedCounts(sql: SqlStorage): SealedCounts {
	const counts: SealedCounts = { explicit: 0, derived: 0 };
	for (const [table, column] of SEALED_COLUMNS) {
		// The names are this file's own, never input. substr, not LIKE, whose `_` matches anything.
		const row = sql
			.exec<{ explicit: number | null; derived: number | null }>(
				`SELECT sum(substr(${column}, 1, 3) = ?) AS explicit, sum(substr(${column}, 1, 3) = ?) AS derived FROM ${table}`,
				`${EXPLICIT}.`,
				`${DERIVED}.`,
			)
			.one();
		counts.explicit += row.explicit ?? 0;
		counts.derived += row.derived ?? 0;
	}
	return counts;
}

/**
 * Puts `to` wherever `from` is stored. A sealed value's nonce is random, so `from` names one
 * place, and a value replaced since it was read is left as it is. Whether it was put anywhere.
 */
export function replaceSealed(sql: SqlStorage, from: string, to: string): boolean {
	let written = 0;
	for (const [table, column] of SEALED_COLUMNS) {
		written += sql.exec(
			`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`,
			to,
			from,
		).rowsWritten;
	}
	return written > 0;
}
