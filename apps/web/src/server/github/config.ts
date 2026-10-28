import { env } from "cloudflare:workers";
import { GitHubApp, type OAuthClient } from "@gateweave/agents-github";

export interface GitHubConfig {
	app: GitHubApp;
	/** The app's URL name, as in github.com/apps/<slug>. */
	slug: string;
	oauth: OAuthClient;
	webhookSecret: string;
}

let config: GitHubConfig | null | undefined;

/**
 * The GitHub App this server runs as, or null when it has none: connecting GitHub is optional,
 * and needs every one of these settings (see docs/github-app.md). Built on first use, like auth.
 */
export function github(): GitHubConfig | null {
	if (config !== undefined) return config;
	const {
		GITHUB_APP_ID: appId,
		GITHUB_APP_SLUG: slug,
		GITHUB_APP_CLIENT_ID: clientId,
		GITHUB_APP_CLIENT_SECRET: clientSecret,
		GITHUB_APP_PRIVATE_KEY: privateKey,
		GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
	} = env;
	config =
		appId && slug && clientId && clientSecret && privateKey && webhookSecret
			? {
					app: new GitHubApp({ appId, privateKey }),
					slug,
					oauth: { clientId, clientSecret },
					webhookSecret,
				}
			: null;
	return config;
}
