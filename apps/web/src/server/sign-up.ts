import { env } from "cloudflare:workers";

/**
 * Where someone without a way in can ask for one, from `SIGN_UP_REQUEST_URL`. Only an https address
 * counts: it is shown as a link to people who are not signed in, and anything else is left out.
 */
export function signUpRequestUrl(): string | undefined {
	if (!env.SIGN_UP_REQUEST_URL) return undefined;
	try {
		const url = new URL(env.SIGN_UP_REQUEST_URL);
		return url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}
