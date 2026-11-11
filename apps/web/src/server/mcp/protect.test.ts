import { createInMemoryDpopReplayStore } from "better-auth/oauth2";
import { exportJWK, generateKeyPair, type JSONWebKeySet, type JWTPayload, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProtectedResourceOptions, protectResource } from "./protect";

const issuer = "https://agents.example.com/api/auth";
const resource = "https://agents.example.com/mcp";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signingKey: SigningKey;
let otherKey: SigningKey;
let jwks: JSONWebKeySet;

beforeAll(async () => {
	const pair = await generateKeyPair("EdDSA", { extractable: true });
	signingKey = pair.privateKey;
	otherKey = (await generateKeyPair("EdDSA")).privateKey;
	jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "key-1", alg: "EdDSA" }] };
});

function token(
	claims: JWTPayload = {},
	{ key = signingKey, audience = resource, expiresIn = "5m" } = {},
): Promise<string> {
	return new SignJWT({ scope: "agents offline_access", azp: "client-1", ...claims })
		.setProtectedHeader({ alg: "EdDSA", kid: "key-1" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject("user-1")
		.setIssuedAt()
		.setExpirationTime(expiresIn)
		.sign(key);
}

function request(authorization?: string): Request {
	return new Request(resource, {
		method: "POST",
		headers: authorization ? { authorization } : {},
	});
}

describe("protectResource", () => {
	let loadKeys: ProtectedResourceOptions["jwks"];
	let seen: JWTPayload[];
	let handle: (request: Request) => Promise<Response>;

	beforeEach(() => {
		// The keys come from the authorization server in the same Worker; going over the network
		// to the Worker's own hostname is what failed in production.
		vi.stubGlobal("fetch", () => Promise.reject(new Error("unexpected network request")));
		loadKeys = vi.fn(async () => jwks);
		seen = [];
		handle = protectResource(
			{
				issuer,
				resource,
				requiredScopes: ["agents"],
				challengeScopes: ["agents", "offline_access"],
				jwks: loadKeys,
				dpopReplayStore: createInMemoryDpopReplayStore(),
			},
			async (_request, claims) => {
				seen.push(claims);
				return new Response("ok");
			},
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("passes a valid token's claims to the handler, reading the keys in-process", async () => {
		const response = await handle(request(`Bearer ${await token()}`));
		await handle(request(`Bearer ${await token()}`));

		expect(response.status).toBe(200);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject({
			sub: "user-1",
			azp: "client-1",
			scope: "agents offline_access",
		});
		// Cached between requests, like keys fetched from a JWKS URL.
		expect(loadKeys).toHaveBeenCalledTimes(1);
	});

	it("challenges a request without a token so the client can start the OAuth flow", async () => {
		const response = await handle(request());

		expect(response.status).toBe(401);
		const challenge = response.headers.get("www-authenticate") ?? "";
		expect(challenge).toContain(
			'resource_metadata="https://agents.example.com/.well-known/oauth-protected-resource',
		);
		expect(challenge).toContain('scope="agents offline_access"');
		expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
		expect(seen).toEqual([]);
	});

	it.each([
		["signed by another key", () => token({}, { key: otherKey })],
		["for another resource", () => token({}, { audience: "https://elsewhere.example.com/mcp" })],
		["without azp", () => token({ azp: undefined })],
		["that is not a JWT", async () => "not-a-token"],
		["with an unreadable header", async () => "e30.e30.e30x"],
	])("rejects a token %s with a 401", async (_, makeToken) => {
		const response = await handle(request(`Bearer ${await makeToken()}`));

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
		expect(seen).toEqual([]);
	});

	it("rejects an expired token with a 401", async () => {
		const expired = await token({}, { expiresIn: "-1m" });

		const response = await handle(request(`Bearer ${expired}`));

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: { message: "token expired" } });
	});

	it("answers a token without the required scope with an insufficient_scope 403", async () => {
		const response = await handle(request(`Bearer ${await token({ scope: "openid" })}`));

		expect(response.status).toBe(403);
		const challenge = response.headers.get("www-authenticate") ?? "";
		expect(challenge).toContain('error="insufficient_scope"');
		expect(challenge).toContain('scope="agents"');
		expect(seen).toEqual([]);
	});

	it("rejects a DPoP-bound token presented as a bearer token", async () => {
		const bound = await token({ cnf: { jkt: "thumbprint" } });

		const response = await handle(request(`Bearer ${bound}`));

		expect(response.status).toBe(401);
		expect(seen).toEqual([]);
	});

	it("fails loudly, not with a 401, when the keys cannot be loaded", async () => {
		loadKeys = vi.fn(async () => {
			throw new Error("D1 is unavailable");
		});
		handle = protectResource(
			{
				issuer,
				resource,
				requiredScopes: ["agents"],
				challengeScopes: ["agents"],
				jwks: loadKeys,
				dpopReplayStore: createInMemoryDpopReplayStore(),
			},
			async () => new Response("ok"),
		);

		await expect(handle(request(`Bearer ${await token()}`))).rejects.toThrow("D1 is unavailable");
	});
});
