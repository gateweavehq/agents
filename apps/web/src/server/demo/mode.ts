import { env } from "cloudflare:workers";

/**
 * True only on the public demo deployment (the `demo` environment in wrangler.jsonc). The same
 * code ships everywhere, so every demo entry point and every guard checks this first.
 */
export function demoEnabled(): boolean {
	return env.AGENTS_DEMO === "1";
}

/** Thrown for problems the visitor should read, such as having asked too often. */
export class DemoError extends Error {}

/** Stops a demo-only action on any other deployment. */
export function assertDemo(): void {
	if (!demoEnabled()) throw new DemoError("The demo is not enabled on this deployment");
}

/**
 * Visitors get a random address here. The domain is reserved for documentation, so it never
 * receives mail, and it is how cleanup tells a visitor from anyone else.
 */
export const VISITOR_DOMAIN = "visitors.example.com";

/** How long a sandbox lives before cleanup deletes it. */
export const SANDBOX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** What the server answers when a visitor tries something the demo has off. */
export const OFF_IN_DEMO = "This is off in the demo. Deploy your own Gateweave Agents to use it.";
