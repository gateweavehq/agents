import { and, inArray, like, lt } from "drizzle-orm";
import { db } from "../auth";
import { schema } from "../db";
import { deleteWorkspaceData } from "../workspace-deletion";
import { assertDemo, SANDBOX_LIFETIME_MS, VISITOR_DOMAIN } from "./mode";

/**
 * Visitors handled per run. Each sandbox has a registry and five or so conversations, each deleted
 * with a subrequest, so a run stays well inside the 1,000 a Worker gets. Every 10 minutes, that
 * clears up to 600 visitors an hour, more than a busy launch day opens.
 */
const BATCH = 100;

export interface CleanupResult {
	workspaces: number;
	visitors: number;
	failed: number;
}

/**
 * Deletes visitors, and the workspaces they belong to, once they are a day old: each workspace's
 * conversations and registry through the same path as deleting a workspace in the app, then its
 * row, then the visitor's. Run by the demo's Cron Trigger. Safe to run twice, and to run while a
 * run before it was cut short: what is left is found again.
 *
 * A visitor is a user under {@link VISITOR_DOMAIN}. Members, invitations, sessions and accounts
 * go with their workspace or user (foreign keys cascade in D1).
 */
export async function cleanUpDemo(now = Date.now()): Promise<CleanupResult> {
	assertDemo();
	const cutoff = new Date(now - SANDBOX_LIFETIME_MS);

	// By the visitor's age, not the workspace's: the workspace is created a moment after the
	// user, and a visitor deleted first would leave their workspace with no one to find it by.
	const visitors = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(and(like(schema.user.email, `%@${VISITOR_DOMAIN}`), lt(schema.user.createdAt, cutoff)))
		.limit(BATCH)
		.all();
	const result: CleanupResult = { workspaces: 0, visitors: 0, failed: 0 };
	if (visitors.length === 0) {
		console.log("demo cleanup: nothing to delete");
		return result;
	}

	const visitorIds = visitors.map((visitor) => visitor.id);
	const memberships = await db
		.select({ workspaceId: schema.member.organizationId, userId: schema.member.userId })
		.from(schema.member)
		.where(inArray(schema.member.userId, visitorIds))
		.all();

	const failedVisitors = new Set<string>();
	const deleted = new Set<string>();
	for (const { workspaceId, userId } of memberships) {
		if (deleted.has(workspaceId)) continue;
		try {
			// Its objects first: were the row deleted first and this to fail, nothing would point at
			// them any more.
			await deleteWorkspaceData(db, workspaceId);
			await db.delete(schema.organization).where(inArray(schema.organization.id, [workspaceId]));
			deleted.add(workspaceId);
			result.workspaces++;
		} catch (error) {
			console.error("demo cleanup: could not delete a workspace", workspaceId, error);
			failedVisitors.add(userId);
			result.failed++;
		}
	}

	// A visitor whose workspace is still there stays too, so the next run finds it again.
	const removable = visitorIds.filter((id) => !failedVisitors.has(id));
	if (removable.length > 0) {
		await db.delete(schema.user).where(inArray(schema.user.id, removable));
	}
	result.visitors = removable.length;

	console.log(
		`demo cleanup: deleted ${result.visitors} visitors and ${result.workspaces} workspaces` +
			(result.failed ? `, ${result.failed} failed` : "") +
			(visitors.length === BATCH ? " (more remain for the next run)" : ""),
	);
	return result;
}
