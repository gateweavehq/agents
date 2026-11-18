/**
 * A repository's checks (AGT-142; `checks.ts` in the model package): the commands
 * `open_pull_request` runs on an agent's work before it pushes it. They are kept on the
 * repository's row and written only by `setRepositoryChecks`, which the app calls for an owner or
 * admin. Nothing read from the repository itself, a scan among it, ever writes them.
 */
import { and, eq, isNull } from "drizzle-orm";
import { repositories } from "./db/schema";
import type { Db } from "./state";

/** What `setRepositoryChecks` changed: the repository as `owner/name`, and its checks then and now. */
export interface ChecksSet {
	repository: string;
	before: string[];
	checks: string[];
}

/**
 * Gives a repository exactly these checks. Null when the workspace has no such repository on
 * GitHub: a sandbox checks out no other, so another's checks would be kept and never run.
 */
export function setRepositoryChecks(
	db: Db,
	repositoryId: string,
	checks: string[],
	now: number,
): ChecksSet | null {
	const found = db
		.select({ owner: repositories.owner, name: repositories.name, checks: repositories.checks })
		.from(repositories)
		.where(
			and(
				eq(repositories.id, repositoryId),
				eq(repositories.provider, "github"),
				isNull(repositories.removedAt),
			),
		)
		.get();
	if (!found) return null;
	db.update(repositories)
		.set({ checks, updatedAt: now })
		.where(eq(repositories.id, repositoryId))
		.run();
	return { repository: `${found.owner}/${found.name}`, before: found.checks, checks };
}

/**
 * The checks of the GitHub repository a sandbox has checked out, as they are set now. A
 * repository the connection no longer reaches keeps its checks, so work under way on it is
 * still held to them; one the workspace never had has none.
 */
export function checksOfRepository(db: Db, externalId: string): string[] {
	const found = db
		.select({ checks: repositories.checks })
		.from(repositories)
		.where(and(eq(repositories.provider, "github"), eq(repositories.externalId, externalId)))
		.get();
	return found?.checks ?? [];
}
