// Optional configuration. Required secrets are declared under `secrets.required` in
// wrangler.jsonc, which is what `wrangler types` generates the rest of `Cloudflare.Env` from.
declare namespace Cloudflare {
	interface Env {
		/** Public URL of the app. Inferred from the request when unset. */
		BETTER_AUTH_URL?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
		/**
		 * Who email comes from, such as `Gateweave Agents <agents@example.com>`. The domain must be
		 * onboarded to Cloudflare Email Sending. Email is off when unset.
		 */
		EMAIL_FROM?: string;
		/**
		 * The GitHub App that reads repositories (see docs/github-app.md). Connecting GitHub is off
		 * unless all six are set.
		 */
		GITHUB_APP_ID?: string;
		GITHUB_APP_SLUG?: string;
		GITHUB_APP_CLIENT_ID?: string;
		GITHUB_APP_CLIENT_SECRET?: string;
		GITHUB_APP_PRIVATE_KEY?: string;
		GITHUB_APP_WEBHOOK_SECRET?: string;
	}
}
