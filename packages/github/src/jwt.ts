import { base64url, encoder, fromBase64 } from "./encoding";

/**
 * Reads a GitHub App's private key. GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY")
 * and WebCrypto reads only PKCS#8, so a PKCS#1 key is wrapped first. Escaped newlines, as some
 * secret stores keep them, are accepted.
 */
export function importAppKey(pem: string): Promise<CryptoKey> {
	const text = pem.replace(/\\n/g, "\n").trim();
	const pkcs1 = text.includes("BEGIN RSA PRIVATE KEY");
	const der = fromBase64(text.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
	return crypto.subtle.importKey(
		"pkcs8",
		pkcs1 ? pkcs1ToPkcs8(der) : der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

/**
 * The JWT a GitHub App authenticates as itself with. GitHub allows at most ten minutes and
 * advises issuing it a minute in the past, against clock drift.
 */
export async function appJwt(appId: string, key: CryptoKey, now = Date.now()): Promise<string> {
	const issuedAt = Math.floor(now / 1000) - 60;
	const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const payload = base64url(
		encoder.encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId })),
	);
	const input = `${header}.${payload}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input));
	return `${input}.${base64url(new Uint8Array(signature))}`;
}

// PrivateKeyInfo: version 0, the rsaEncryption algorithm with NULL parameters, then the PKCS#1
// key as an octet string.
const RSA_ALGORITHM = [
	0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
	0x05, 0x00,
];

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const octets = [0x04, ...derLength(pkcs1.length)];
	const length = RSA_ALGORITHM.length + octets.length + pkcs1.length;
	return Uint8Array.from([0x30, ...derLength(length), ...RSA_ALGORITHM, ...octets, ...pkcs1]);
}

function derLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
	return [0x80 | bytes.length, ...bytes];
}
