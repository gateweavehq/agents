import { getRequestHeaders } from "@tanstack/react-start/server";
import { db, getAuth } from "./auth";
import { findMembership } from "./workspaces";

/**
 * The signed-in user and their membership in the workspace with this slug, or null when nobody
 * is signed in or the user is not a member. Server functions that read or change a workspace
 * start here.
 */
export async function currentMember(slug: string) {
	const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
	if (!session) return null;
	const membership = await findMembership(db, slug, session.user.id);
	return (
		membership && { user: session.user, membership, sessionCreatedAt: session.session.createdAt }
	);
}

/** Matches Better Auth's freshSessionMiddleware, including deployments that disable freshness. */
export async function requireFreshSession(createdAt: Date) {
	const { sessionConfig } = await getAuth().$context;
	if (
		sessionConfig.freshAge !== 0 &&
		Date.now() - createdAt.getTime() >= sessionConfig.freshAge * 1000
	) {
		throw new Error("Sign in again to resume this agent.");
	}
}
