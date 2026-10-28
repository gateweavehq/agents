/**
 * Connecting a workspace to GitHub, and keeping it in step afterwards.
 *
 * 1. An admin opens /api/github/install. It sends them to install the app on GitHub, carrying a
 *    signed state that names the workspace.
 * 2. GitHub sends them to /api/github/setup with the installation's id. Anyone can call that URL
 *    with any id, so the id is not trusted yet: the admin is sent on to authorize the app.
 * 3. GitHub sends them to /api/github/callback with a code. The app trades it for a user token,
 *    checks that the installation is among the ones this person can reach, and only then links
 *    it to the workspace and lists its repositories. The token is not kept.
 *
 * Webhooks then report installs, uninstalls and changes to the repositories the app reaches.
 */
import { env } from "cloudflare:workers";
import {
	authorizeUrl,
	exchangeCode,
	pkcePair,
	userInstallationIds,
	verifyWebhook,
	webhookPayload,
} from "@gateweave/agents-github";
import { isAdmin } from "#/lib/roles";
import { db, getAuth } from "../auth";
import { findMembership, findMembershipById } from "../workspaces";
import { github } from "./config";
import {
	findInstallation,
	type LinkedInstallation,
	linkInstallation,
	syncInstallation,
	unlinkInstallation,
} from "./installations";
import { FLOW_LIFETIME_MS, readState, signState } from "./state";

/** How the flow ended, shown on the workspace's GitHub settings. */
export type ConnectResult = "connected" | "denied" | "taken" | "requested" | "failed" | "forbidden";

const PKCE_COOKIE = "github_pkce";
const VERIFY_LIFETIME_MS = 10 * 60 * 1000;
const INSTALLATION_ID = /^\d{1,20}$/;

export async function startInstall(request: Request): Promise<Response> {
	const config = github();
	if (!config) return new Response("GitHub is not set up on this server", { status: 404 });
	const url = new URL(request.url);
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
	const slug = url.searchParams.get("workspace") ?? "";
	const membership = await findMembership(db, slug, session.user.id);
	if (!membership) return new Response("Not found", { status: 404 });
	if (!isAdmin(membership.role)) return redirect(settingsPath(slug, "forbidden"));
	const state = await signState({
		step: "install",
		workspaceId: membership.workspaceId,
		userId: session.user.id,
		expiresAt: Date.now() + FLOW_LIFETIME_MS,
	});
	const install = new URL(
		`https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`,
	);
	install.searchParams.set("state", state);
	return redirect(install.href);
}

export async function finishInstall(request: Request): Promise<Response> {
	const config = github();
	if (!config) return new Response("GitHub is not set up on this server", { status: 404 });
	const url = new URL(request.url);
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
	const state = await readState(url.searchParams.get("state"), "install");
	const installationId = url.searchParams.get("installation_id") ?? "";
	const membership =
		state?.userId === session.user.id
			? await findMembershipById(db, state.workspaceId, session.user.id)
			: null;

	if (!state || !membership || !isAdmin(membership.role)) {
		// GitHub also sends people here after they change the app's settings on GitHub, with no
		// state of ours. Webhooks bring those changes in; this only finds them a page to land on.
		const linked = INSTALLATION_ID.test(installationId)
			? await findInstallation(installationId)
			: undefined;
		const member = linked && (await findMembershipById(db, linked.workspaceId, session.user.id));
		return redirect(member ? settingsPath(member.slug) : "/");
	}
	// An organization member without rights to install asked an owner to approve it.
	if (url.searchParams.get("setup_action") === "request") {
		return redirect(settingsPath(membership.slug, "requested"));
	}
	if (!INSTALLATION_ID.test(installationId)) {
		return redirect(settingsPath(membership.slug, "failed"));
	}

	const { verifier, challenge } = await pkcePair();
	const verify = await signState({
		step: "verify",
		workspaceId: state.workspaceId,
		userId: session.user.id,
		installationId,
		expiresAt: Date.now() + VERIFY_LIFETIME_MS,
	});
	const response = redirect(
		authorizeUrl(config.oauth, { redirectUri: callbackUrl(request), state: verify, challenge }),
	);
	response.headers.append(
		"set-cookie",
		cookie(request, PKCE_COOKIE, verifier, VERIFY_LIFETIME_MS / 1000),
	);
	return response;
}

export async function finishVerify(request: Request): Promise<Response> {
	const config = github();
	if (!config) return new Response("GitHub is not set up on this server", { status: 404 });
	const url = new URL(request.url);
	const session = await getAuth().api.getSession({ headers: request.headers });
	const state = await readState(url.searchParams.get("state"), "verify");
	const membership =
		session && state?.userId === session.user.id
			? await findMembershipById(db, state.workspaceId, session.user.id)
			: null;
	if (!state?.installationId || !membership || !isAdmin(membership.role)) return redirect("/");

	const finish = (result: ConnectResult) => {
		const response = redirect(settingsPath(membership.slug, result));
		response.headers.append("set-cookie", cookie(request, PKCE_COOKIE, "", 0));
		return response;
	};
	const code = url.searchParams.get("code");
	const verifier = readCookie(request, PKCE_COOKIE);
	if (!code || !verifier) return finish("failed");

	try {
		const token = await exchangeCode(config.oauth, {
			code,
			redirectUri: callbackUrl(request),
			verifier,
		});
		if (!(await userInstallationIds(token)).has(state.installationId)) return finish("denied");
		const installation = await config.app.installation(state.installationId);
		// state.userId is the signed-in user, checked above.
		if ((await linkInstallation(state.workspaceId, installation, state.userId)) === "taken") {
			return finish("taken");
		}
		const linked = await findInstallation(installation.id);
		if (linked) await syncInstallation(linked);
		return finish("connected");
	} catch (error) {
		console.error("github: connecting failed", error);
		return finish("failed");
	}
}

/**
 * A webhook from GitHub. Only signed deliveries for linked installations do anything; the
 * rest are acknowledged and dropped.
 */
export async function receiveWebhook(request: Request): Promise<Response> {
	const config = github();
	if (!config) return new Response(null, { status: 404 });
	const body = await request.text();
	const signature = request.headers.get("x-hub-signature-256");
	if (!(await verifyWebhook(config.webhookSecret, body, signature))) {
		return new Response("Bad signature", { status: 401 });
	}
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return new Response("Not JSON", { status: 400 });
	}
	const parsed = webhookPayload.safeParse(json);
	const installationId = parsed.success ? parsed.data.installation?.id : undefined;
	const linked = installationId ? await findInstallation(installationId) : undefined;
	if (!parsed.success || !linked) return new Response(null, { status: 202 });

	try {
		return await handleEvent(request.headers.get("x-github-event"), parsed.data.action, linked);
	} catch (error) {
		// GitHub shows the failed delivery, and it can be redelivered from the app's settings.
		console.error("github: webhook failed", error);
		return new Response("Failed", { status: 502 });
	}
}

async function handleEvent(
	event: string | null,
	action: string | undefined,
	linked: LinkedInstallation,
): Promise<Response> {
	switch (event) {
		case "installation":
			if (action === "deleted") {
				await unlinkInstallation(linked);
				return new Response(null, { status: 204 });
			}
			// A suspended installation has no access; its repositories stay until it comes back.
			if (action === "suspend") return new Response(null, { status: 202 });
			await syncInstallation(linked);
			return new Response(null, { status: 204 });
		case "installation_repositories":
		case "repository":
			await syncInstallation(linked);
			return new Response(null, { status: 204 });
		default:
			return new Response(null, { status: 202 });
	}
}

function settingsPath(slug: string, result?: ConnectResult) {
	const path = `/${encodeURIComponent(slug)}/settings/github`;
	return result ? `${path}?github=${result}` : path;
}

/** Where GitHub sends people back to. It must be the app's registered callback URL. */
function callbackUrl(request: Request) {
	const origin = env.BETTER_AUTH_URL
		? new URL(env.BETTER_AUTH_URL).origin
		: new URL(request.url).origin;
	return `${origin}/api/github/callback`;
}

function redirect(location: string) {
	return new Response(null, { status: 302, headers: { location } });
}

function cookie(request: Request, name: string, value: string, maxAge: number) {
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${name}=${value}; Path=/api/github; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=") || null;
	}
	return null;
}
