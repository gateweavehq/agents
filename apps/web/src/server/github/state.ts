import { env } from "cloudflare:workers";
import { z } from "zod";

/**
 * What the connect flow carries through GitHub in its `state` parameter, signed so nobody can
 * forge one: who started it, for which workspace, and, once GitHub has named it, the
 * installation to verify.
 */
const flowState = z.object({
	step: z.enum(["install", "verify"]),
	workspaceId: z.string(),
	userId: z.string(),
	installationId: z.string().optional(),
	expiresAt: z.number(),
});
export type FlowState = z.infer<typeof flowState>;

/** Long enough to pick repositories on GitHub; short enough that a leaked link soon dies. */
export const FLOW_LIFETIME_MS = 30 * 60 * 1000;

const encoder = new TextEncoder();
let key: Promise<CryptoKey> | undefined;

function signingKey() {
	key ??= crypto.subtle.importKey(
		"raw",
		encoder.encode(`gateweave-agents/github-state/${env.BETTER_AUTH_SECRET}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	return key;
}

export async function signState(state: FlowState): Promise<string> {
	const payload = toBase64url(encoder.encode(JSON.stringify(state)));
	const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
	return `${payload}.${toBase64url(new Uint8Array(signature))}`;
}

/** The state, if it is signed by this server, unexpired and at the expected step. */
export async function readState(
	token: string | null,
	step: FlowState["step"],
): Promise<FlowState | null> {
	const [payload, signature, ...rest] = token?.split(".") ?? [];
	if (!payload || !signature || rest.length > 0) return null;
	try {
		const key = await signingKey();
		if (
			!(await crypto.subtle.verify("HMAC", key, fromBase64url(signature), encoder.encode(payload)))
		) {
			return null;
		}
		const parsed = flowState.safeParse(
			JSON.parse(new TextDecoder().decode(fromBase64url(payload))),
		);
		if (!parsed.success || parsed.data.step !== step || parsed.data.expiresAt < Date.now()) {
			return null;
		}
		return parsed.data;
	} catch {
		// Not base64, or not JSON: not one of ours.
		return null;
	}
}

function toBase64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
