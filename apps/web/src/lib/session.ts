import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

/**
 * A session as it may reach a page. What a route's `beforeLoad` returns is written into the HTML,
 * where the cookie's point is that scripts and saved documents do not get the token, and no page
 * needs it.
 */
function withoutToken<Found extends { session: { token: string } }>(found: Found | null) {
	if (!found) return null;
	const { token: _token, ...session } = found.session;
	return { ...found, session };
}

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	return withoutToken(await getAuth().api.getSession({ headers: getRequestHeaders() }));
});

/**
 * For the account page: who this is, whether deleting them needs a password, and whether they run
 * the server, which is what shows them its settings.
 */
export const getAccount = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth, db, oidcProviderName } = await import("#/server/auth");
	const { ownsServer } = await import("#/server/auth/deployment");
	const { demoEnabled } = await import("#/server/demo/mode");
	const { legalLinks } = await import("#/server/legal");
	const auth = getAuth();
	const legal = legalLinks();
	const found = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!found) return { account: null, legal };
	const { internalAdapter } = await auth.$context;
	const accounts = await internalAdapter.findAccounts(found.user.id);
	const hasPassword = accounts.some(
		({ providerId, password }) => providerId === "credential" && Boolean(password),
	);
	const { name, email } = found.user;
	// A demo visitor runs nothing: the server's settings are refused to them however they ask.
	const demo = demoEnabled();
	const ownsThisServer = !demo && (await ownsServer(db, found.user.id));
	return {
		account: { name, email, hasPassword, ownsServer: ownsThisServer, demo },
		legal,
		provider: ownsThisServer ? oidcProviderName : null,
	};
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { db, emailEnabled, githubEnabled, oidcProviderName } = await import("#/server/auth");
	const { signUpState } = await import("#/server/auth/deployment");
	const { legalLinks } = await import("#/server/legal");
	const { signUpRequestUrl } = await import("#/server/sign-up");
	const { demoEnabled } = await import("#/server/demo/mode");
	const closed = (await signUpState(db)) === "by-invitation";
	return {
		/** The public demo, where "Open the demo" is the only way in. */
		demo: demoEnabled(),
		github: githubEnabled,
		oidc: oidcProviderName,
		email: emailEnabled,
		legal: legalLinks(),
		/** Whether new accounts are by invitation, so the page can say so. */
		signUpClosed: closed,
		/** Where to ask for an invitation, if the server says. */
		requestAccessUrl: closed ? (signUpRequestUrl() ?? null) : null,
	};
});

export const getLegalLinks = createServerFn({ method: "GET" }).handler(async () => {
	const { legalLinks } = await import("#/server/legal");
	return legalLinks();
});
