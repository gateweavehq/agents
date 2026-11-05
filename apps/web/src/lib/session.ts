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

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { emailEnabled, githubEnabled, oidcProviderName } = await import("#/server/auth");
	const { legalLinks } = await import("#/server/legal");
	return {
		github: githubEnabled,
		oidc: oidcProviderName,
		email: emailEnabled,
		legal: legalLinks(),
	};
});

export const getLegalLinks = createServerFn({ method: "GET" }).handler(async () => {
	const { legalLinks } = await import("#/server/legal");
	return legalLinks();
});
