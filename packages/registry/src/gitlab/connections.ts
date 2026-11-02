/**
 * GitLab connections (AGT-79): a GitLab the workspace reaches with an access token. Its projects
 * are repositories with `provider: "gitlab"`, whose `installationId` is the connection's id, so
 * reconciling and removing them works as for a GitHub App installation.
 */

import { createHash } from "node:crypto";
import {
	type GitLabConnection,
	type RepositoryInput,
	repositoryInput,
} from "@gateweave/agents-model";
import { and, count, eq, isNull } from "drizzle-orm";
import { gitlabConnections, repositories } from "../db/schema";
import type { Db } from "../state";
import type { GitLabProject } from "./client";

/** Most GitLab connections a workspace keeps. */
export const MAX_GITLAB_CONNECTIONS = 10;

/** Where each sealed part is sealed, which ties it to its connection's row. */
export const gitlabPlace = (connectionId: string, part: "token" | "webhook") =>
	`gitlab/${connectionId}/${part}`;

/**
 * A project's id among every GitLab's: GitLab numbers projects per instance, so gitlab.com's
 * project 7 and a self-managed GitLab's are two repositories. The host comes first, hashed when
 * it is too long to fit.
 */
export function gitlabExternalId(baseUrl: string, projectId: string): string {
	const host = new URL(baseUrl).host.toLowerCase();
	const name =
		host.length <= 80 ? host : createHash("sha256").update(host).digest("hex").slice(0, 32);
	return `${name}:${projectId}`;
}

/**
 * The projects as repositories. GitLab's answers are checked like any input: a project whose
 * names are too long is left out.
 */
export function projectInputs(
	connectionId: string,
	baseUrl: string,
	projects: readonly GitLabProject[],
): RepositoryInput[] {
	return projects.flatMap((project) => {
		const input = repositoryInput.safeParse({
			provider: "gitlab",
			externalId: gitlabExternalId(baseUrl, project.id),
			installationId: connectionId,
			owner: project.namespace,
			name: project.path,
			// Made from the connection's address, so a link can only lead to the GitLab the admin
			// entered, whatever a project's answer says.
			webUrl: `${baseUrl}/${[...project.namespace.split("/"), project.path].map(encodeURIComponent).join("/")}`,
			defaultBranch: project.defaultBranch,
			private: project.private,
		});
		return input.success ? [input.data] : [];
	});
}

export function connectionRow(db: Db, connectionId: string) {
	return (
		db.select().from(gitlabConnections).where(eq(gitlabConnections.id, connectionId)).get() ?? null
	);
}

export function listConnections(db: Db): GitLabConnection[] {
	const reached = new Map(
		db
			.select({ connection: repositories.installationId, live: count() })
			.from(repositories)
			.where(and(eq(repositories.provider, "gitlab"), isNull(repositories.removedAt)))
			.groupBy(repositories.installationId)
			.all()
			.map(({ connection, live }) => [connection, live]),
	);
	return db
		.select()
		.from(gitlabConnections)
		.orderBy(gitlabConnections.createdAt)
		.all()
		.map((row) => ({
			id: row.id,
			baseUrl: row.baseUrl,
			account: row.account,
			tokenHint: row.tokenHint,
			repositories: reached.get(row.id) ?? 0,
			createdBy: row.createdBy,
			createdAt: row.createdAt,
			syncedAt: row.syncedAt,
			syncError: row.syncError,
			lastDeliveryAt: row.lastDeliveryAt,
		}));
}

export function connectionCount(db: Db): number {
	return db.select({ total: count() }).from(gitlabConnections).get()?.total ?? 0;
}

export function recordSync(
	db: Db,
	connectionId: string,
	outcome: { at: number; error: string | null },
): void {
	db.update(gitlabConnections)
		.set(
			outcome.error === null
				? { syncedAt: outcome.at, syncError: null }
				: { syncError: outcome.error },
		)
		.where(eq(gitlabConnections.id, connectionId))
		.run();
}

export function recordDelivery(db: Db, connectionId: string, at: number): void {
	db.update(gitlabConnections)
		.set({ lastDeliveryAt: at })
		.where(eq(gitlabConnections.id, connectionId))
		.run();
}

export function forgetConnection(db: Db, connectionId: string): boolean {
	const removed = db
		.delete(gitlabConnections)
		.where(eq(gitlabConnections.id, connectionId))
		.returning({ id: gitlabConnections.id })
		.get();
	return removed !== undefined;
}
