import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export interface GitHubInstallationSummary {
	id: string;
	accountLogin: string;
	accountType: string;
}

/**
 * The workspace's GitHub connection: whether this server has a GitHub App at all, whether the
 * caller may change the connection, and the installations linked. Null for non-members.
 */
export const getGitHubSettings = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { currentMember } = await import("#/server/access");
		const member = await currentMember(slug);
		if (!member) return null;
		const { github } = await import("#/server/github/config");
		const { listInstallations } = await import("#/server/github/installations");
		const { isAdmin } = await import("#/lib/roles");
		const installations = await listInstallations(member.membership.workspaceId);
		return {
			configured: github() !== null,
			canManage: isAdmin(member.membership.role),
			installations: installations.map(
				({ id, accountLogin, accountType }): GitHubInstallationSummary => ({
					id,
					accountLogin,
					accountType,
				}),
			),
		};
	});

/** Unlinks an installation from the workspace and drops its repositories. Admins only. */
export const disconnectGitHub = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), installationId: z.string().min(1).max(32) }))
	.handler(async ({ data }) => {
		const { currentMember } = await import("#/server/access");
		const { isAdmin } = await import("#/lib/roles");
		const member = await currentMember(data.slug);
		if (!member || !isAdmin(member.membership.role)) throw new Error("Only admins can do this");
		const { findInstallation, unlinkInstallation } = await import("#/server/github/installations");
		const installation = await findInstallation(data.installationId);
		if (installation?.workspaceId !== member.membership.workspaceId) {
			throw new Error("This workspace has no such installation");
		}
		await unlinkInstallation(installation);
	});
