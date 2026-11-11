import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import {
	createInsufficientScopeError,
	type DpopReplayStore,
	enforceDpopBinding,
	isDpopBindingError,
	parseAccessTokenAuthorization,
	verifyJwsAccessToken,
} from "better-auth/oauth2";
import type { JSONWebKeySet, JWTPayload } from "jose";

export interface ProtectedResourceOptions {
	/** The authorization server that signs the tokens. */
	issuer: string;
	/** This resource's URL. Tokens must be issued for it. */
	resource: string;
	/** Scopes every token must carry. */
	requiredScopes: readonly string[];
	/** Scopes a 401 tells the client to ask for. */
	challengeScopes: readonly string[];
	/** The issuer's public signing keys. */
	jwks: () => Promise<JSONWebKeySet>;
	dpopReplayStore: DpopReplayStore;
}

export type ProtectedHandler = (request: Request, claims: JWTPayload) => Promise<Response>;

/**
 * Lets through only requests with a valid access token for `resource`, and answers the rest with
 * the RFC 9728 challenge that MCP clients follow to start the OAuth flow.
 *
 * It checks what `requireMcpAuth` from `@better-auth/mcp` checks (signature, issuer, audience,
 * expiry, `azp`, scopes and DPoP binding) and answers the same way. Only the keys come from
 * elsewhere: `requireMcpAuth` fetches them from the issuer's JWKS URL, which is this Worker's own
 * hostname, and in production that fetch fails, so every request with a token threw. The
 * authorization server runs in this Worker, so the keys are read in-process instead.
 */
export function protectResource(
	options: ProtectedResourceOptions,
	handler: ProtectedHandler,
): (request: Request) => Promise<Response> {
	// Caches the keys per isolate, with the same expiry and rotation refetch as a JWKS URL.
	const jwksCacheKey = {};

	async function verify(request: Request): Promise<JWTPayload> {
		const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
		if (!authorization?.token) throw unauthorized("missing authorization header");
		if (authorization.scheme === "Unknown") {
			throw unauthorized("authorization scheme must be Bearer or DPoP", "invalid_token");
		}

		let payload: JWTPayload;
		try {
			payload = await verifyJwsAccessToken(authorization.token, {
				jwksFetch: options.jwks,
				jwksCacheKey,
				verifyOptions: {
					issuer: options.issuer,
					audience: options.resource,
					requiredClaims: ["azp"],
				},
			});
		} catch (error) {
			if (errorCode(error) === "ERR_JWT_EXPIRED") throw unauthorized("token expired");
			if (isInvalidTokenError(error)) throw unauthorized("invalid access token");
			throw error;
		}

		const granted = new Set(typeof payload.scope === "string" ? payload.scope.split(" ") : []);
		const missing = options.requiredScopes.filter((scope) => !granted.has(scope));
		if (missing.length > 0) throw createInsufficientScopeError(missing);

		try {
			await enforceDpopBinding({
				payload,
				authorization,
				proofJwt: request.headers.get("dpop"),
				method: request.method,
				url: request.url,
				replayStore: options.dpopReplayStore,
			});
		} catch (error) {
			if (isDpopBindingError(error)) throw unauthorized(error.message, error.code);
			throw error;
		}
		return payload;
	}

	return async (request) => {
		let claims: JWTPayload;
		try {
			claims = await verify(request);
		} catch (error) {
			return challenge(error, options);
		}
		return handler(request, claims);
	};
}

/**
 * jose errors that mean the token is bad, as opposed to the keys being unavailable. Matched by
 * code rather than class, because the classes differ between copies of jose.
 */
const INVALID_TOKEN_ERRORS = new Set([
	"ERR_JWT_INVALID",
	"ERR_JWT_CLAIM_VALIDATION_FAILED",
	"ERR_JWS_INVALID",
	"ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
	"ERR_JWKS_NO_MATCHING_KEY",
	"ERR_JOSE_ALG_NOT_ALLOWED",
	"ERR_JOSE_NOT_SUPPORTED",
]);

function isInvalidTokenError(error: unknown): boolean {
	const code = errorCode(error);
	// jose reports a header it cannot decode as a TypeError.
	return code ? INVALID_TOKEN_ERRORS.has(code) : error instanceof TypeError;
}

function errorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function unauthorized(message: string, code?: string): APIError {
	return new APIError(
		"UNAUTHORIZED",
		code ? { message, error: code, error_description: message } : { message },
	);
}

/** Answers a failed check as a JSON-RPC error carrying the OAuth challenge, as MCP expects. */
function challenge(error: unknown, options: ProtectedResourceOptions): Response {
	const result = createResourceServerChallenge(error, options.resource, {
		challengeScopes: options.challengeScopes,
	});
	if (!result) throw error;
	return Response.json(
		{ jsonrpc: "2.0", error: { code: -32000, message: result.message }, id: null },
		{ status: result.statusCode, headers: result.headers },
	);
}
