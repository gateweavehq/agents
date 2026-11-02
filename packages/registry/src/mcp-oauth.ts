/**
 * MCP servers connected through OAuth (AGT-78). An owner or admin connects a library server for
 * the workspace; `@ai-sdk/mcp`'s OAuth client does the flow (discovery, dynamic client
 * registration, PKCE, the token exchange and refreshing), and keeps what it needs here between
 * steps, through the app's provider (`apps/web/src/server/mcp-oauth.ts`). What is secret, the
 * client's registration, the PKCE verifier and the tokens, is sealed (`secrets.ts`) by the
 * registry and opened only for the app's provider, never for a page.
 *
 * A connection is for the URL the server had when it was made: if the server moves, it is not
 * sent there, and an admin connects again. A flow's `state` is single-use, lasts
 * `STATE_LIFETIME_MS`, and is bound to whoever started it.
 */
import { and, eq } from "drizzle-orm";
import { mcpOAuth } from "./db/schema";
import type { Db } from "./state";

/** How long someone has to finish signing in at the server once they started. */
export const STATE_LIFETIME_MS = 10 * 60_000;

/** Where each sealed part is sealed, which ties it to its server's row. */
export const oauthPlace = (assetId: string, part: "client" | "verifier" | "tokens") =>
	`mcp-oauth/${assetId}/${part}`;

export type McpOAuthRow = typeof mcpOAuth.$inferSelect;

export function oauthRow(db: Db, assetId: string): McpOAuthRow | null {
	return db.select().from(mcpOAuth).where(eq(mcpOAuth.assetId, assetId)).get() ?? null;
}

/**
 * Starts a flow for a server at `serverUrl`: a new state for `by`, and no verifier. A registration
 * made with the same authorization server for the same URL is kept, so signing in again does not
 * register another client; tokens are kept until the new ones replace them.
 */
export function beginOAuth(
	db: Db,
	{ assetId, serverUrl, by }: { assetId: string; serverUrl: string; by: string },
	state: string,
	now: number,
): void {
	const existing = oauthRow(db, assetId);
	const sameServer = existing?.serverUrl === serverUrl;
	const row = {
		assetId,
		serverUrl,
		authorizationServer: sameServer ? (existing?.authorizationServer ?? null) : null,
		sealedClient: sameServer ? (existing?.sealedClient ?? null) : null,
		sealedVerifier: null,
		sealedTokens: sameServer ? (existing?.sealedTokens ?? null) : null,
		state,
		stateBy: by,
		stateExpiresAt: now + STATE_LIFETIME_MS,
		connectedBy: sameServer ? (existing?.connectedBy ?? null) : null,
		connectedAt: sameServer ? (existing?.connectedAt ?? null) : null,
	};
	db.insert(mcpOAuth).values(row).onConflictDoUpdate({ target: mcpOAuth.assetId, set: row }).run();
}

/**
 * Takes a flow's state as the server sends it back: true when it is the one under way, `by`
 * started it, and it has not expired. Either way it is used up.
 */
export function takeState(
	db: Db,
	assetId: string,
	state: string,
	by: string,
	now: number,
): boolean {
	const row = oauthRow(db, assetId);
	if (!row || row.state === null) return false;
	db.update(mcpOAuth)
		.set({ state: null, stateBy: null, stateExpiresAt: null })
		.where(eq(mcpOAuth.assetId, assetId))
		.run();
	return (
		row.state === state &&
		row.stateBy === by &&
		row.stateExpiresAt !== null &&
		row.stateExpiresAt > now
	);
}

/** Keeps what the OAuth client saves; a part left out stays as it is. */
export function saveOAuth(
	db: Db,
	assetId: string,
	parts: {
		sealedClient?: string | null;
		sealedVerifier?: string | null;
		sealedTokens?: string | null;
		authorizationServer?: Record<string, unknown> | null;
	},
): boolean {
	const saved = db
		.update(mcpOAuth)
		.set(parts)
		.where(eq(mcpOAuth.assetId, assetId))
		.returning({ assetId: mcpOAuth.assetId })
		.get();
	return saved !== undefined;
}

/** Marks a server connected, once its first tokens are kept. */
export function markConnected(db: Db, assetId: string, by: string, now: number): void {
	db.update(mcpOAuth)
		.set({ connectedBy: by, connectedAt: now })
		.where(eq(mcpOAuth.assetId, assetId))
		.run();
}

export function forgetOAuth(db: Db, assetId: string): boolean {
	const removed = db
		.delete(mcpOAuth)
		.where(eq(mcpOAuth.assetId, assetId))
		.returning({ assetId: mcpOAuth.assetId })
		.get();
	return removed !== undefined;
}

/**
 * Whether a server is connected for the URL it has now, so a turn sends its token: there are
 * tokens, and the connection was made for this URL.
 */
export function connectedFor(db: Db, assetId: string, serverUrl: string): boolean {
	const row = db
		.select({ tokens: mcpOAuth.sealedTokens, url: mcpOAuth.serverUrl })
		.from(mcpOAuth)
		.where(and(eq(mcpOAuth.assetId, assetId)))
		.get();
	return row !== undefined && row.tokens !== null && row.url === serverUrl;
}
