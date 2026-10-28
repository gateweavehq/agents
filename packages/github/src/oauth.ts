// The web application flow for a GitHub App's user access tokens. The app uses one only to
// learn which installations the person in front of it can reach, then forgets it.
import { z } from "zod";
import { GitHubError } from "./app";
import { base64url, encoder } from "./encoding";

export const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface OAuthClient {
	clientId: string;
	clientSecret: string;
}

/** A PKCE verifier and the challenge that goes to GitHub with the authorization request. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizeUrl(
	client: OAuthClient,
	{ redirectUri, state, challenge }: { redirectUri: string; state: string; challenge: string },
): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("client_id", client.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.href;
}

const tokenResponse = z.union([
	z.object({ access_token: z.string() }),
	z.object({ error: z.string(), error_description: z.string().optional() }),
]);

/** Trades the code from the callback for a user access token. */
export async function exchangeCode(
	client: OAuthClient,
	{ code, redirectUri, verifier }: { code: string; redirectUri: string; verifier: string },
): Promise<string> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({
			client_id: client.clientId,
			client_secret: client.clientSecret,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
	});
	if (!response.ok) throw new GitHubError(response.status, "GitHub refused the code");
	const result = tokenResponse.parse(await response.json());
	if ("error" in result) throw new GitHubError(400, `GitHub refused the code: ${result.error}`);
	return result.access_token;
}
