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
		/**
		 * Encrypts what workspaces entrust to the server, such as model provider keys: at least 32
		 * random bytes, base64 (`openssl rand -base64 32`). Model keys are off when unset. Never
		 * change it once keys are saved: they cannot be opened without it.
		 */
		SECRETS_KEY?: string;
		/**
		 * The AI Gateway that agents' model calls go through, as
		 * `https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>`. Calls go straight to the
		 * providers when unset. Each call still carries the workspace's own key.
		 */
		AI_GATEWAY_URL?: string;
		/** The gateway's token, when it is an authenticated gateway. */
		AI_GATEWAY_TOKEN?: string;
		/**
		 * A Cloudflare API token with Workers AI permission. Workers AI is offered to every workspace
		 * only when this is set (with an account, below), and this deployment's Cloudflare account
		 * pays for its runs. Never put it in wrangler.jsonc.
		 */
		WORKERS_AI_TOKEN?: string;
		/**
		 * The Cloudflare account that pays for Workers AI. Taken from AI_GATEWAY_URL when unset.
		 */
		CLOUDFLARE_ACCOUNT_ID?: string;
	}
}
