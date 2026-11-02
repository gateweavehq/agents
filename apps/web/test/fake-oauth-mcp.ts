/**
 * An MCP server that signs in with OAuth, as the MCP authorization spec describes, as small as the
 * tests need: protected resource and authorization server metadata, dynamic client registration,
 * an authorization endpoint the test approves for the person, PKCE (S256), a token endpoint that
 * trades codes and refresh tokens, and a Streamable HTTP endpoint that wants a bearer token.
 */
export class FakeOAuthMcp {
	readonly origin: string;
	/** Every request it answered, by method and path. */
	readonly requests: string[] = [];
	/** The bearer tokens the MCP endpoint was sent. */
	readonly bearers: string[] = [];
	readonly #codes = new Map<string, { challenge: string; redirect: string; client: string }>();
	readonly #refresh = new Map<string, number>();
	readonly #valid = new Set<string>();
	#issued = 0;

	constructor(host: string) {
		this.origin = `https://${host}`;
	}

	get mcpUrl() {
		return `${this.origin}/mcp`;
	}

	/** The person approves at the authorization URL: returns the code the server sends back. */
	approve(authorizationUrl: string): { code: string; state: string; redirect: string } {
		const url = new URL(authorizationUrl);
		if (url.origin !== this.origin || url.pathname !== "/authorize") {
			throw new Error(`Not this server's authorization URL: ${authorizationUrl}`);
		}
		const challenge = url.searchParams.get("code_challenge") ?? "";
		if (url.searchParams.get("code_challenge_method") !== "S256" || challenge === "") {
			throw new Error("The sign-in has no PKCE challenge");
		}
		const code = `code-${crypto.randomUUID()}`;
		this.#codes.set(code, {
			challenge,
			redirect: url.searchParams.get("redirect_uri") ?? "",
			client: url.searchParams.get("client_id") ?? "",
		});
		return {
			code,
			state: url.searchParams.get("state") ?? "",
			redirect: url.searchParams.get("redirect_uri") ?? "",
		};
	}

	/** Makes every token it gave out so far stop working, as an expiry does. */
	expireAccessTokens() {
		this.#valid.clear();
	}

	handle = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		this.requests.push(`${request.method} ${url.pathname}`);
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			return Response.json({ resource: this.mcpUrl, authorization_servers: [this.origin] });
		}
		if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
			return Response.json({
				issuer: this.origin,
				authorization_endpoint: `${this.origin}/authorize`,
				token_endpoint: `${this.origin}/token`,
				registration_endpoint: `${this.origin}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		}
		if (url.pathname === "/register" && request.method === "POST") {
			const metadata = (await request.json()) as Record<string, unknown>;
			return Response.json(
				{ ...metadata, client_id: "client-1", client_id_issued_at: 1 },
				{ status: 201 },
			);
		}
		if (url.pathname === "/token" && request.method === "POST") return this.#token(request);
		if (url.pathname === "/mcp") return this.#mcp(request);
		return new Response("Not found", { status: 404 });
	};

	async #token(request: Request): Promise<Response> {
		const form = await request.formData();
		const refuse = () => Response.json({ error: "invalid_grant" }, { status: 400 });
		if (form.get("grant_type") === "authorization_code") {
			const code = String(form.get("code") ?? "");
			const grant = this.#codes.get(code);
			this.#codes.delete(code);
			if (!grant || grant.redirect !== form.get("redirect_uri")) return refuse();
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(String(form.get("code_verifier") ?? "")),
			);
			const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			if (challenge !== grant.challenge) return refuse();
			return Response.json(this.#tokens());
		}
		if (form.get("grant_type") === "refresh_token") {
			const refresh = String(form.get("refresh_token") ?? "");
			if (!this.#refresh.has(refresh)) return refuse();
			this.#refresh.delete(refresh);
			return Response.json(this.#tokens());
		}
		return refuse();
	}

	#tokens() {
		this.#issued += 1;
		const access = `access-${this.#issued}`;
		const refresh = `refresh-${this.#issued}`;
		this.#valid.add(access);
		this.#refresh.set(refresh, this.#issued);
		return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
	}

	async #mcp(request: Request): Promise<Response> {
		const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		this.bearers.push(bearer);
		if (!this.#valid.has(bearer)) {
			return new Response("Unauthorized", {
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource"`,
				},
			});
		}
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const message = (await request.json()) as { id?: number | string; method: string };
		if (message.id === undefined) return new Response(null, { status: 202 });
		const result = (value: unknown) =>
			Response.json({ jsonrpc: "2.0", id: message.id, result: value });
		if (message.method === "initialize") {
			return result({
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "oauth-fake", version: "1.0.0" },
			});
		}
		if (message.method === "tools/list") {
			return result({
				tools: [
					{ name: "whoami", description: "Says who you are", inputSchema: { type: "object" } },
				],
			});
		}
		if (message.method === "tools/call") {
			return result({ content: [{ type: "text", text: `You are the holder of ${bearer}` }] });
		}
		return Response.json({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: "Method not found" },
		});
	}
}
