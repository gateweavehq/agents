import { env, waitUntil } from "cloudflare:workers";
import { createDb } from "../db";
import { mailer } from "../email";
import { authRateLimits } from "../rate-limit";
import { deleteWorkspaceData } from "../workspace-deletion";
import { createAuth } from "./config";

export const db = createDb(env.DB);

const baseURL = env.BETTER_AUTH_URL || undefined;

const oidc =
	env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
		? {
				issuer: env.OIDC_ISSUER,
				clientId: env.OIDC_CLIENT_ID,
				clientSecret: env.OIDC_CLIENT_SECRET,
			}
		: undefined;

let instance: ReturnType<typeof buildAuth> | undefined;

/**
 * The isolate's one Better Auth instance, built on first use. Better Auth starts resolving its
 * context as soon as it is created, and workerd forbids I/O in global scope, so a plugin that
 * touches the database while doing so would log an error on every cold start.
 */
export function getAuth() {
	instance ??= buildAuth();
	return instance;
}

const PROVIDER_LOGOUT = "/api/auth/backchannel-logout/";

/**
 * Takes a POST for Better Auth. A provider waits only so long for the answer to a logout token, and
 * its giving up would cancel the request, leaving someone signed in to Agents after signing out there.
 * So a logout is seen through once it has arrived, and read first, while the sender is still there.
 */
export async function postToAuth(request: Request): Promise<Response> {
	if (!new URL(request.url).pathname.startsWith(PROVIDER_LOGOUT)) {
		return getAuth().handler(request);
	}
	const arrived = new Request(request.url, {
		method: "POST",
		headers: request.headers,
		body: await request.arrayBuffer(),
	});
	const answer = getAuth().handler(arrived);
	waitUntil(answer);
	return answer;
}

function buildAuth() {
	return createAuth({
		db,
		secret: env.BETTER_AUTH_SECRET,
		baseURL,
		github:
			env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
				: undefined,
		oidc,
		mailer,
		runInBackground: waitUntil,
		rateLimitStorage: authRateLimits,
		// The conversations and the registry are deleted with their workspace. A failure is logged
		// for the operator; until then the data stays unreachable, since only members get through
		// and none are left.
		onWorkspaceDeleted: (workspaceId) =>
			logFailure(deleteWorkspaceData(workspaceId), "workspace deletion"),
	});
}

async function logFailure(work: Promise<unknown>, what: string) {
	try {
		await work;
	} catch (error) {
		console.error(`auth: ${what} failed`, error);
	}
}

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export const emailEnabled = Boolean(mailer);

/** What the sign-in page calls the OpenID Connect provider, if there is one. */
export const oidcProviderName = oidc ? env.OIDC_PROVIDER_NAME || "single sign-on" : null;
