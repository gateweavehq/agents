import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { registryFor } from "./registry";

// "Deleting an account" in docs/architecture.md.

/**
 * How many workspaces one cron run asks. A Worker on the Free plan makes 50 subrequests at most, and
 * each of these takes two. One that fails goes to the back, so a run of them that keep failing does
 * not keep the rest from a turn.
 */
const RETRIES_PER_RUN = 20;

interface Erasure {
	userId: string;
	organizationId: string;
}

/**
 * Asks each workspace to forget the person. A row goes only once its registry has answered, so one
 * that could not be reached is asked again by the daily cron. Only ids reach the log.
 */
async function forget(db: Database, erasures: Erasure[]): Promise<void> {
	const results = await Promise.allSettled(
		erasures.map(async ({ userId, organizationId }) => {
			const row = and(
				eq(schema.pendingErasure.userId, userId),
				eq(schema.pendingErasure.organizationId, organizationId),
			);
			try {
				await registryFor(organizationId).forgetPerson(userId);
			} catch (error) {
				await db.update(schema.pendingErasure).set({ lastTriedAt: Date.now() }).where(row).run();
				throw error;
			}
			await db.delete(schema.pendingErasure).where(row).run();
		}),
	);
	const failed = results.filter((result) => result.status === "rejected").length;
	if (failed > 0) {
		console.error(`erasure: ${failed} of ${erasures.length} workspaces will be asked again`);
	}
}

/** Right after an account is deleted: the workspaces it left behind. */
export async function forgetInWorkspaces(db: Database, userId: string): Promise<void> {
	const erasures = await db
		.select({
			userId: schema.pendingErasure.userId,
			organizationId: schema.pendingErasure.organizationId,
		})
		.from(schema.pendingErasure)
		.where(eq(schema.pendingErasure.userId, userId))
		.all();
	await forget(db, erasures);
}

/** From the daily cron: whatever is still waiting. */
export async function retryErasures(db: Database): Promise<void> {
	const erasures = await db
		.select({
			userId: schema.pendingErasure.userId,
			organizationId: schema.pendingErasure.organizationId,
		})
		.from(schema.pendingErasure)
		.orderBy(asc(schema.pendingErasure.lastTriedAt), asc(schema.pendingErasure.createdAt))
		.limit(RETRIES_PER_RUN)
		.all();
	if (erasures.length > 0) await forget(db, erasures);
}
