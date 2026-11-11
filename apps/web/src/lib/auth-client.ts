import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	// oauthProviderClient carries an agent's pending authorization through sign-in and consent.
	plugins: [organizationClient(), oauthProviderClient()],
});

/**
 * Whether this page is a step of an agent's authorization (an MCP client signing in). Such pages
 * carry the signed authorization request in their query, and Better Auth decides where to go next.
 */
export function inAuthorizationFlow(search: string): boolean {
	return new URLSearchParams(search).has("sig");
}
