/**
 * Connecting Gateweave Track in one step, the registry's part: the pending connection
 * kept while the person's browser is in Track. It is kept as MCP OAuth keeps its state
 * (`./mcp-oauth.ts`): a random `state`, bound to the person who started it, good for
 * `TRACK_CONNECT_LIFETIME_MS`, and taken, that is deleted, by the first call that names it,
 * whether or not that call was allowed to have it. The verifier is sealed here by the caller and
 * opened only for that call, in the Worker's memory.
 */
import { TRACK_CONNECT_LIFETIME_MS, type TrackPendingChoices } from "@gateweave/agents-model";
import { eq, lt } from "drizzle-orm";
import { trackConnections } from "./db/schema";
import type { Db } from "./state";

/** A random verifier of 64 characters, which only the server that starts the flow keeps. */
export function newVerifier(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(48));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

/** Where the verifier is sealed, which ties it to its row. */
export const trackVerifierPlace = (state: string) => `track-connect/${state}/verifier`;

/** Pending connections a workspace may have at once: each is a person pressing the button. */
export const PENDING_LIMIT = 20;

export interface PendingConnection {
	state: string;
	startedBy: string;
	choices: TrackPendingChoices;
	targetId: string;
	sealedVerifier: string;
}

/** Keeps a connection under way, after dropping the ones that ran out. False when too many wait. */
export function beginConnection(db: Db, pending: PendingConnection, now: number): boolean {
	db.delete(trackConnections).where(lt(trackConnections.expiresAt, now)).run();
	if (
		db.select({ state: trackConnections.state }).from(trackConnections).all().length >=
		PENDING_LIMIT
	) {
		return false;
	}
	db.insert(trackConnections)
		.values({
			state: pending.state,
			startedBy: pending.startedBy,
			expiresAt: now + TRACK_CONNECT_LIFETIME_MS,
			choices: pending.choices,
			targetId: pending.targetId,
			sealedVerifier: pending.sealedVerifier,
		})
		.run();
	return true;
}

/**
 * Takes a connection by its state: the row when `by` started it and it has not expired, else
 * null. Either way it is used up, so a state that reached someone else is spent.
 */
export function takeConnection(
	db: Db,
	state: string,
	by: string,
	now: number,
): PendingConnection | null {
	const row = db.select().from(trackConnections).where(eq(trackConnections.state, state)).get();
	if (!row) return null;
	db.delete(trackConnections).where(eq(trackConnections.state, state)).run();
	if (row.startedBy !== by || row.expiresAt <= now) return null;
	return {
		state: row.state,
		startedBy: row.startedBy,
		choices: row.choices,
		targetId: row.targetId,
		sealedVerifier: row.sealedVerifier,
	};
}
