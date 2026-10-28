import type { Installation } from "@gateweave/agents-github";
import { eq } from "drizzle-orm";
import { db } from "../auth";
import { schema } from "../db";
import { registryFor } from "../registry";
import { github } from "./config";

export type LinkedInstallation = typeof schema.githubInstallation.$inferSelect;

export async function findInstallation(installationId: string) {
	return db
		.select()
		.from(schema.githubInstallation)
		.where(eq(schema.githubInstallation.id, installationId))
		.get();
}

export async function listInstallations(workspaceId: string) {
	return db
		.select()
		.from(schema.githubInstallation)
		.where(eq(schema.githubInstallation.workspaceId, workspaceId))
		.orderBy(schema.githubInstallation.accountLogin)
		.all();
}

export type LinkOutcome = "linked" | "taken";

/**
 * Links an installation to a workspace. One already linked to another workspace stays there:
 * moving it would empty that workspace's registry, so it has to be disconnected first.
 */
export async function linkInstallation(
	workspaceId: string,
	installation: Installation,
	userId: string,
): Promise<LinkOutcome> {
	const existing = await findInstallation(installation.id);
	if (existing && existing.workspaceId !== workspaceId) return "taken";
	const now = new Date();
	const fields = {
		accountLogin: installation.account.login,
		accountType: installation.account.type,
		updatedAt: now,
	};
	await db
		.insert(schema.githubInstallation)
		.values({ id: installation.id, workspaceId, linkedBy: userId, createdAt: now, ...fields })
		.onConflictDoUpdate({ target: schema.githubInstallation.id, set: fields })
		.run();
	return "linked";
}

/** Brings the workspace's registry in line with the repositories GitHub says the app reaches. */
export async function syncInstallation(installation: LinkedInstallation): Promise<void> {
	const config = github();
	if (!config) return;
	const repositories = await config.app.repositories(installation.id);
	await registryFor(installation.workspaceId).reconcileInstallation(installation.id, repositories);
}

/** Forgets the installation and its repositories. On GitHub, the app stays installed. */
export async function unlinkInstallation(installation: LinkedInstallation): Promise<void> {
	await registryFor(installation.workspaceId).removeInstallation(installation.id);
	await db
		.delete(schema.githubInstallation)
		.where(eq(schema.githubInstallation.id, installation.id))
		.run();
}
