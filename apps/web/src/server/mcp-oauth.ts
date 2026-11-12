/**
 * Connecting a library MCP server through OAuth (AGT-78).
 *
 * 1. An owner or admin opens /api/mcp-oauth/connect from the MCP page. The registry makes a
 *    single-use state bound to them, and `@ai-sdk/mcp`'s OAuth client discovers the server's
 *    authorization server, registers the app as a client if it has not yet, and makes the
 *    sign-in URL, with PKCE. They are sent there.
 * 2. The server sends them back to /api/mcp-oauth/callback with a code. The state names the
 *    workspace and the server; the registry takes it only for the same person, once, within ten
 *    minutes, and only while they are still an admin. Then the code is traded for tokens, which
 *    the registry keeps sealed.
 *
 * Agents that pin the server then act as that person on it. Nothing of the tokens reaches a page.
 */
import { env } from "cloudflare:workers";
import { finishOAuth, startOAuth } from "@gateweave/agents-runtime";
import { isAdmin } from "#/lib/roles";
import { db, getAuth } from "./auth";
import { registryFor } from "./registry";
import { findMembership, findMembershipById } from "./workspaces";

/** How the flow ended, shown on the MCP page. */
export type OAuthResult = "connected" | "denied" | "failed" | "forbidden" | "expired";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function startConnect(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
	const slug = url.searchParams.get("workspace") ?? "";
	const assetId = url.searchParams.get("server") ?? "";
	const membership = await findMembership(db, slug, session.user.id);
	if (!membership || !ID.test(assetId)) return new Response("Not found", { status: 404 });
	if (!isAdmin(membership.role)) return redirect(mcpPath(slug, "forbidden"));
	const registry = registryFor(membership.workspaceId);
	const begun = await registry.mcpOAuthBegin(assetId, session.user.id);
	if ("status" in begun) return redirect(mcpPath(slug, "failed"));
	// The state names the workspace and the server, so the callback knows where it belongs.
	const state = `${membership.workspaceId}.${assetId}.${begun.state}`;
	try {
		const destination = await startOAuth(registry, assetId, {
			serverUrl: begun.serverUrl,
			redirectUrl: callbackUrl(request),
			state,
		});
		if (!destination) return redirect(mcpPath(slug, "failed"));
		return redirect(destination.href);
	} catch (error) {
		console.error("mcp-oauth: the sign-in could not start", {
			error: error instanceof Error ? error.message : String(error),
		});
		return redirect(mcpPath(slug, "failed"));
	}
}

export async function finishConnect(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
	const [workspaceId = "", assetId = "", token = ""] = (url.searchParams.get("state") ?? "").split(
		".",
	);
	if (!ID.test(workspaceId) || !ID.test(assetId) || token === "") {
		return new Response("Not found", { status: 404 });
	}
	const membership = await findMembershipById(db, workspaceId, session.user.id);
	if (!membership) return new Response("Not found", { status: 404 });
	const { slug } = membership;
	if (!isAdmin(membership.role)) return redirect(mcpPath(slug, "forbidden"));
	const registry = registryFor(workspaceId);
	// Used up whatever comes next, so a code cannot be replayed with it.
	if (!(await registry.mcpOAuthTakeState(assetId, token, session.user.id))) {
		return redirect(mcpPath(slug, "expired"));
	}
	const code = url.searchParams.get("code");
	if (!code) return redirect(mcpPath(slug, url.searchParams.get("error") ? "denied" : "failed"));
	// RPC types an `unknown` field as `never`; only the URL is read here.
	const opened = (await registry.mcpOAuthOpen(assetId)) as { serverUrl: string } | null;
	if (!opened) return redirect(mcpPath(slug, "failed"));
	try {
		await finishOAuth(registry, assetId, {
			serverUrl: opened.serverUrl,
			redirectUrl: callbackUrl(request),
			code,
			state: url.searchParams.get("state") ?? "",
			...(url.searchParams.get("iss") ? { issuer: url.searchParams.get("iss") ?? "" } : {}),
		});
	} catch (error) {
		console.error("mcp-oauth: the code could not be traded for tokens", {
			error: error instanceof Error ? error.message : String(error),
		});
		return redirect(mcpPath(slug, "failed"));
	}
	await registry.mcpOAuthConnected(assetId, session.user.id);
	const [{ auditFor }, { hostOf }] = await Promise.all([
		import("./audit"),
		import("../lib/audit-events"),
	]);
	await auditFor({ user: session.user, membership: { workspaceId } })({
		action: "mcpServer.connected",
		target: {
			type: "mcpServer",
			id: assetId,
			label: (await registry.getAsset(assetId))?.asset.name ?? null,
		},
		detail: { host: hostOf(opened.serverUrl) },
	});
	return redirect(mcpPath(slug, "connected"));
}

function mcpPath(slug: string, result: OAuthResult) {
	return `/${encodeURIComponent(slug)}/mcp?oauth=${result}`;
}

/** Where the server sends people back to: the app's own callback, on its public address. */
function callbackUrl(request: Request) {
	const origin = env.BETTER_AUTH_URL
		? new URL(env.BETTER_AUTH_URL).origin
		: new URL(request.url).origin;
	return `${origin}/api/mcp-oauth/callback`;
}

function redirect(location: string) {
	return new Response(null, { status: 302, headers: { location } });
}
