import { env } from "cloudflare:workers";

/**
 * Where the app shows a workspace's runs, which a trigger's run is told its page under: at
 * `BETTER_AUTH_URL` when it is set, as links in email are, else at `origin`. Null when neither is
 * known, as for a scheduled run on a server without `BETTER_AUTH_URL`.
 */
export function runsPage(slug: string, origin: string | null = null): string | null {
	let base = origin;
	try {
		if (env.BETTER_AUTH_URL) base = new URL(env.BETTER_AUTH_URL).origin;
	} catch {
		// A setting that is not a URL leaves the request's origin.
	}
	return base === null ? null : `${base}/${encodeURIComponent(slug)}/runs/`;
}
