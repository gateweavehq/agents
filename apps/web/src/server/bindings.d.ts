// Optional bindings, which `wrangler types` leaves out because only some environments in
// wrangler.jsonc have them. Settings that are secrets or vars go in env.d.ts.
declare namespace Cloudflare {
	interface Env {
		/**
		 * A Workers Analytics Engine dataset that gets one usage event for each run that closes, for
		 * charting usage across workspaces (docs/self-hosting.md). Nothing is written when unbound.
		 */
		USAGE?: AnalyticsEngineDataset;
	}
}
