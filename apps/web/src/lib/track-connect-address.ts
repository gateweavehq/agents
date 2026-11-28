/**
 * The address a browser is sent to when Track is connected: Track's approval page, with
 * what it needs to show what is asked and where the answer goes. No server code, so the tests
 * read it as they read `audit-events.ts`.
 */
import {
	TRACK_CONNECT_EVENTS,
	TRACK_SOURCE_NAME,
	TRACK_SOURCE_PRODUCT,
	type TrackConnectPurpose,
} from "@gateweave/agents-model";

function base64Url(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** What Track is shown of the verifier: its SHA-256, base64url without padding. */
export async function challengeOf(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

/** Where Track is told to post the webhook: the trigger that does not exist yet has its id. */
export function triggerUrl(origin: string, workspaceId: string, triggerId: string): string {
	return `${origin}/api/triggers/${workspaceId}/${triggerId}`;
}

/**
 * Where Track sends the browser back to. It names the workspace, so the callback knows whose
 * pending connection the state is; Track keeps a return address's own query and adds to it. The
 * state cannot carry it: Track takes only letters, digits, `_` and `-` there.
 */
export function returnUrl(origin: string, workspaceId: string): string {
	return `${origin}/api/track/connected?workspace=${encodeURIComponent(workspaceId)}`;
}

/**
 * The address to send the browser to. `webhook` and `return` share one origin, `origin`, which
 * Track insists on. The verifier is not in it; its hash is.
 */
export async function trackConnectAddress(options: {
	trackUrl: string;
	purpose: TrackConnectPurpose;
	name: string;
	/** This deployment's public origin. */
	origin: string;
	workspaceId: string;
	triggerId: string;
	state: string;
	verifier: string;
}): Promise<string> {
	const address = new URL("/connect/agent", options.trackUrl);
	const query = address.searchParams;
	query.set("purpose", options.purpose);
	query.set("name", options.name);
	query.set("webhook", triggerUrl(options.origin, options.workspaceId, options.triggerId));
	query.set("events", TRACK_CONNECT_EVENTS[options.purpose].join(","));
	query.set("return", returnUrl(options.origin, options.workspaceId));
	query.set("state", options.state);
	query.set("challenge", await challengeOf(options.verifier));
	return address.href;
}

export async function trackSourceAddress(options: {
	trackUrl: string;
	origin: string;
	workspaceId: string;
	state: string;
	verifier: string;
}): Promise<string> {
	const address = new URL("/connect/source", options.trackUrl);
	const query = address.searchParams;
	query.set("product", TRACK_SOURCE_PRODUCT);
	query.set("name", TRACK_SOURCE_NAME);
	query.set("links", options.origin);
	query.set(
		"return",
		`${options.origin}/api/track/source-connected?workspace=${encodeURIComponent(options.workspaceId)}`,
	);
	query.set("state", options.state);
	query.set("challenge", await challengeOf(options.verifier));
	return address.href;
}
