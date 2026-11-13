/**
 * The workspace's GitLab connections (AGT-79). Members see which GitLabs are connected; owners
 * and admins connect, sync and disconnect them, and see the push webhook's address. A token goes
 * to the registry and never comes back: the page gets its last four characters, and the webhook's
 * secret token is shown once, when it is made.
 */
import { type GitLabConnection, gitlabConnectionInput } from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function memberOf(slug: string) {
	const { currentMember } = await import("#/server/access");
	const member = await currentMember(slug);
	if (!member) return null;
	const [{ isAdmin }, { registryFor }, { appOrigin }] = await Promise.all([
		import("#/lib/roles"),
		import("#/server/registry"),
		import("#/server/origin"),
	]);
	const { workspaceId, role } = member.membership;
	const origin = appOrigin();
	return {
		member,
		admin: isAdmin(role),
		registry: registryFor(member.membership),
		webhookUrl: (connectionId: string) =>
			`${origin}/api/gitlab/webhooks/${workspaceId}/${connectionId}`,
	};
}

async function adminOf(slug: string) {
	const found = await memberOf(slug);
	if (!found) throw new Error("Workspace not found");
	if (!found.admin) throw new Error("Only admins can do this");
	const { auditFor } = await import("#/server/audit");
	return { ...found, audit: auditFor(found.member) };
}

/** A connection as the audit log names it: the account, at the GitLab it is on. */
function gitlabTarget(connection: GitLabConnection) {
	const host = new URL(connection.baseUrl).host;
	return { type: "gitlab" as const, id: connection.id, label: `${connection.account} on ${host}` };
}

/** A connection as the page shows it; its webhook's address only to owners and admins. */
export type GitLabConnectionView = GitLabConnection & { webhookUrl: string | null };

export const getGitLabConnections = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({
			data: slug,
		}): Promise<
			{ member: false } | { member: true; admin: boolean; connections: GitLabConnectionView[] }
		> => {
			const found = await memberOf(slug);
			if (!found) return { member: false };
			const connections = await found.registry.gitlabConnections();
			return {
				member: true,
				admin: found.admin,
				connections: connections.map((connection) => ({
					...connection,
					webhookUrl: found.admin ? found.webhookUrl(connection.id) : null,
				})),
			};
		},
	);

export const connectGitLab = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), connection: gitlabConnectionInput }))
	.handler(
		async ({ data }): Promise<{ connection: GitLabConnectionView; webhookSecret: string }> => {
			const found = await adminOf(data.slug);
			const { name, email } = found.member.user;
			const made = await found.registry.gitlabConnect(data.connection, name || email);
			if ("status" in made) throw new Error(made.message);
			await found.audit({ action: "gitlab.connected", target: gitlabTarget(made.connection) });
			return {
				connection: { ...made.connection, webhookUrl: found.webhookUrl(made.connection.id) },
				webhookSecret: made.webhookSecret,
			};
		},
	);

const connectionAction = z.object({ slug: z.string().min(1), connectionId: z.string().min(1) });

export const syncGitLab = createServerFn({ method: "POST" })
	.validator(connectionAction)
	.handler(async ({ data }): Promise<GitLabConnectionView> => {
		const found = await adminOf(data.slug);
		const synced = await found.registry.gitlabSync(data.connectionId);
		if ("status" in synced) throw new Error(synced.message);
		return { ...synced, webhookUrl: found.webhookUrl(synced.id) };
	});

export const newGitLabWebhookSecret = createServerFn({ method: "POST" })
	.validator(connectionAction)
	.handler(async ({ data }): Promise<string> => {
		const found = await adminOf(data.slug);
		const secret = await found.registry.gitlabNewWebhookSecret(data.connectionId);
		if (typeof secret !== "string") throw new Error(secret.message);
		const connection = (await found.registry.gitlabConnections()).find(
			(candidate) => candidate.id === data.connectionId,
		);
		if (connection) {
			await found.audit({ action: "gitlab.secretReplaced", target: gitlabTarget(connection) });
		}
		return secret;
	});

export const disconnectGitLab = createServerFn({ method: "POST" })
	.validator(connectionAction)
	.handler(async ({ data }): Promise<boolean> => {
		const found = await adminOf(data.slug);
		const connection = (await found.registry.gitlabConnections()).find(
			(candidate) => candidate.id === data.connectionId,
		);
		const disconnected = await found.registry.gitlabDisconnect(data.connectionId);
		if (disconnected && connection) {
			await found.audit({ action: "gitlab.disconnected", target: gitlabTarget(connection) });
		}
		return disconnected;
	});
