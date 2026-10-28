import { createHash, createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appJwt, GitHubApp, importAppKey, pkcePair, verifyWebhook } from "../src";

const { privateKey: pkcs1, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const { privateKey: pkcs8 } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

function decode(part: string | undefined) {
	return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("appJwt", () => {
	it("signs with the PKCS#1 key GitHub hands out, as GitHub expects", async () => {
		const now = Date.UTC(2026, 9, 28, 12);
		const jwt = await appJwt("12345", await importAppKey(pkcs1), now);
		const [header, payload, signature] = jwt.split(".");

		expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
		// Issued a minute early against clock drift, and valid for less than ten minutes.
		expect(decode(payload)).toEqual({ iss: "12345", iat: now / 1000 - 60, exp: now / 1000 + 480 });
		const verify = createVerify("RSA-SHA256").update(`${header}.${payload}`);
		expect(verify.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
	});

	it("reads PKCS#8 keys, and keys whose newlines were escaped", async () => {
		await expect(importAppKey(pkcs8)).resolves.toBeDefined();
		await expect(importAppKey(pkcs1.replace(/\n/g, "\\n"))).resolves.toBeDefined();
	});
});

describe("verifyWebhook", () => {
	const body = JSON.stringify({ action: "added", installation: { id: 1 } });
	const sign = (secret: string, text: string) =>
		`sha256=${createHmac("sha256", secret).update(text).digest("hex")}`;

	it("accepts the body signed with the secret, and nothing else", async () => {
		expect(await verifyWebhook("s3cret", body, sign("s3cret", body))).toBe(true);
		expect(await verifyWebhook("s3cret", body, sign("other", body))).toBe(false);
		expect(await verifyWebhook("s3cret", `${body} `, sign("s3cret", body))).toBe(false);
		expect(await verifyWebhook("s3cret", body, null)).toBe(false);
		expect(await verifyWebhook("s3cret", body, "sha1=abc")).toBe(false);
	});
});

describe("pkcePair", () => {
	it("makes the S256 challenge of its verifier", async () => {
		const { verifier, challenge } = await pkcePair();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
	});
});

describe("GitHubApp", () => {
	it("reuses an installation token until shortly before it expires", async () => {
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${input}`);
			const auth = new Headers(init?.headers).get("authorization") ?? "";
			if (input.endsWith("/access_tokens")) {
				expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
				return Response.json({ token: "ghs_installation", expires_at: expiresAt });
			}
			expect(auth).toBe("Bearer ghs_installation");
			return Response.json({
				total_count: 1,
				repositories: [
					{
						id: 7,
						name: "site",
						owner: { login: "acme" },
						default_branch: "main",
						private: true,
					},
				],
			});
		});
		const app = new GitHubApp({ appId: "1", privateKey: pkcs1 });

		expect(await app.repositories("99")).toEqual([
			{
				provider: "github",
				externalId: "7",
				installationId: "99",
				owner: "acme",
				name: "site",
				defaultBranch: "main",
				private: true,
			},
		]);
		await app.repositories("99");
		expect(calls).toEqual([
			"POST https://api.github.com/app/installations/99/access_tokens",
			"GET https://api.github.com/installation/repositories?per_page=100&page=1",
			"GET https://api.github.com/installation/repositories?per_page=100&page=1",
		]);
	});
});
