import { z } from "zod";
import { encoder, fromHex } from "./encoding";

/**
 * True when `signature`, the `X-Hub-Signature-256` header, is the body's HMAC under the
 * webhook secret. WebCrypto's verify compares in constant time.
 */
export async function verifyWebhook(
	secret: string,
	body: string,
	signature: string | null,
): Promise<boolean> {
	const hex = signature?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
	if (!hex) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, fromHex(hex), encoder.encode(body));
}

const id = z.union([z.number().int(), z.string()]).transform(String);

/** The fields of webhook payloads the app reads. Everything else is ignored. */
export const webhookPayload = z.object({
	action: z.string().optional(),
	installation: z.object({ id }).optional(),
	ref: z.string().optional(),
	after: z.string().optional(),
	repository: z
		.object({
			id,
			default_branch: z.string().optional(),
		})
		.optional(),
});
export type WebhookPayload = z.infer<typeof webhookPayload>;
