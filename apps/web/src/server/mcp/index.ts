import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDpopReplayStore } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { db, getAuth, mcpResource } from "../auth";
import { MCP_SCOPE } from "../auth/config";
import { registryFor } from "../registry";
import { listWorkspaces, workspaceIdsOf } from "../workspaces";
import { protectResource } from "./protect";
import { type AgentsAccess, createAgentsServer } from "./tools";

const MCP_PATH = "/mcp";

export function isMcpRequest(url: URL): boolean {
	return url.pathname === MCP_PATH;
}

/**
 * Gateway for AI agents that read Agents, not to be confused with the library's "MCP servers",
 * which Agents' own agents connect to (`mcp-oauth.ts`). Like the chat gateway, it is the only way
 * to a workspace: every tool call resolves the workspace to the caller's membership in D1 first.
 *
 * Agents authenticate with an OAuth access token issued by Agents' own authorization server
 * (Better Auth's MCP plugin), bound to this endpoint and scoped to `agents`, and act as the
 * person who approved them. Session cookies are never accepted here, so a web page cannot make a
 * signed-in browser call it. Without `BETTER_AUTH_URL` there is no canonical URL to bind tokens
 * to, so the endpoint does not exist.
 */
export function handleMcpRequest(request: Request): Promise<Response> | Response {
	if (!protectedHandler) return Response.json({ error: "Not found" }, { status: 404 });
	return protectedHandler(request);
}

const protectedHandler = mcpResource ? protect(mcpResource) : null;

function protect(resource: string) {
	const mcpHandler = createMcpHandler(({ authInfo }) => {
		const userId = authInfo?.extra?.userId;
		// protectResource only lets verified tokens through, and they always carry both.
		if (typeof userId !== "string" || !authInfo?.clientId) {
			throw new Error("MCP request without verified credentials");
		}
		return createAgentsServer(accessFor(userId));
	});

	const serve = (request: Request, claims: JWTPayload) => {
		const clientId = typeof claims.azp === "string" ? claims.azp : claims.client_id;
		return mcpHandler.fetch(request, {
			authInfo: {
				token: request.headers.get("Authorization")?.replace(/^\S+\s+/, "") ?? "",
				clientId: typeof clientId === "string" ? clientId : "",
				scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
				expiresAt: claims.exp,
				resource: new URL(resource),
				extra: { userId: claims.sub },
			},
		});
	};

	// Built on the first request, once Better Auth's context has resolved. The handler itself is
	// kept rather than a promise of it, so no request waits on work another request started.
	let handler: ((request: Request) => Promise<Response>) | undefined;
	return async (request: Request) => {
		if (!handler) {
			const { baseURL, internalAdapter } = await getAuth().$context;
			handler = protectResource(
				{
					issuer: baseURL,
					resource,
					requiredScopes: [MCP_SCOPE],
					// offline_access lets clients refresh tokens instead of asking the user again.
					challengeScopes: [MCP_SCOPE, "offline_access"],
					jwks: () => getAuth().api.getJwks(),
					dpopReplayStore: createDpopReplayStore(internalAdapter),
				},
				serve,
			);
		}
		return handler(request);
	};
}

/** What a caller reaches: every workspace the user is in, each found through D1 first. */
function accessFor(userId: string): AgentsAccess {
	const membershipsIn = async (workspace: string | undefined) =>
		(await workspaceIdsOf(db, userId)).filter(
			(membership) => workspace === undefined || membership.slug === workspace,
		);
	return {
		async workspaces() {
			return listWorkspaces(db, userId);
		},
		async wikiRepos(workspace) {
			const memberships = await membershipsIn(workspace);
			const listed = await Promise.all(
				memberships.map(async (membership) =>
					(await registryFor({ workspaceId: membership.id, ...membership }).listWikis()).flatMap(
						(entry) =>
							entry.live
								? [
										{
											workspace: membership.slug,
											repoName: `${entry.owner}/${entry.name}`,
											private: entry.private,
											pages: entry.live.pagesTotal,
											commit: entry.live.commit,
											writtenAt: entry.live.finishedAt,
										},
									]
								: [],
					),
				),
			);
			return listed.flat();
		},
		async wikis(repoName, workspace) {
			const memberships = await membershipsIn(workspace);
			const matches = await Promise.all(
				memberships.map(async (membership) => {
					const registry = registryFor({ workspaceId: membership.id, ...membership });
					const repositoryId = await registry.wikiRepositoryNamed(repoName);
					if (!repositoryId) return null;
					const wiki = await registry.readWiki(repositoryId);
					return {
						workspace: membership.slug,
						repoName: wiki?.repoName ?? repoName,
						pages: wiki?.pages ?? null,
					};
				}),
			);
			return matches.filter((match) => match !== null);
		},
	};
}
