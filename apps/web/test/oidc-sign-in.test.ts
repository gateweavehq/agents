import type { JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAgents } from "./agents-worker";
import { LOGOUT_EVENT, OIDC, OIDC_VARS, standInProvider } from "./oidc-provider";

// Sign-in through an OpenID Connect provider (AGT-80). Agents never trusts the provider beyond what
// it signed: an existing account links only when both sides have verified the address, and every
// refused sign-in must leave no session behind. A provider that is down must not touch anything
// but its own button, and its logout tokens must end the sessions they name and no others.

const origin = "https://agents.test";
const PASSWORD = "a-long-test-password";

type Provider = Awaited<ReturnType<typeof standInProvider>>;
type Agents = Awaited<ReturnType<typeof startAgents>>;

/** Where the Worker's requests to the provider go. */
function providerHost(provider: Provider) {
	return {
		[new URL(OIDC.issuer).host]: async (request: Request) =>
			(await provider.outbound(request, new URL(request.url))) ??
			new Response("Not the provider", { status: 502 }),
	};
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

/** Each test comes from its own address, because sign-ins are limited per address. */
let clients = 0;
function newClient() {
	clients += 1;
	return `198.51.100.${clients}`;
}

function authApi(
	agents: Agents,
	path: string,
	init: { client: string; cookie?: string; body: object },
) {
	return agents.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			"content-type": "application/json",
			...(init.cookie && { cookie: init.cookie }),
		},
		body: JSON.stringify(init.body),
	});
}

/** Presses the button: where Agents sends the browser, and the cookie that binds the way back. */
async function pressButton(agents: Agents, client: string) {
	const response = await authApi(agents, "/sign-in/social", {
		client,
		body: { provider: "oidc", callbackURL: "/", errorCallbackURL: "/login" },
	});
	expect(response.status).toBe(200);
	const { url } = (await response.json()) as { url: string };
	return { authorize: new URL(url), cookie: cookieOf(response) };
}

/** Comes back from the provider with a code. */
async function comeBack(
	agents: Agents,
	client: string,
	authorize: URL,
	cookie: string,
	code: string,
) {
	const query = new URLSearchParams({
		code,
		state: authorize.searchParams.get("state") ?? "",
		iss: OIDC.issuer,
	});
	const response = await agents.fetch(`${origin}/api/auth/callback/oidc?${query}`, {
		headers: { cookie, "cf-connecting-ip": client },
	});
	expect(response.status).toBe(302);
	return {
		location: new URL(response.headers.get("location") ?? "", origin),
		cookie: cookieOf(response),
	};
}

async function sessionOf(agents: Agents, cookie: string) {
	const response = await agents.fetch(`${origin}/api/auth/get-session`, { headers: { cookie } });
	return (await response.json()) as null | {
		session: Record<string, unknown>;
		user: { id: string; email: string; name: string; emailVerified: boolean };
	};
}

/** Whether a cookie from `comeBack` is a working session. */
async function isSignedIn(agents: Agents, cookie: string) {
	return (await sessionOf(agents, cookie)) !== null;
}

interface Person {
	sub: string;
	email: string;
	name?: string;
	sid?: string;
	email_verified?: unknown;
}

/** Someone the provider knows signs in to Agents from start to finish. */
async function signIn(agents: Agents, provider: Provider, person: Person, client = newClient()) {
	const { authorize, cookie } = await pressButton(agents, client);
	const code = provider.grant(authorize, {
		name: "Pat Provider",
		email_verified: true,
		...person,
	});
	return comeBack(agents, client, authorize, cookie, code);
}

async function signUpWithPassword(agents: Agents, email: string, client = newClient()) {
	const response = await authApi(agents, "/sign-up/email", {
		client,
		body: { name: "Sam Password", email, password: PASSWORD },
	});
	expect(response.status).toBe(200);
	return cookieOf(response);
}

async function verifyAddress(agents: Agents, email: string) {
	await agents.db.prepare("UPDATE user SET email_verified = 1 WHERE email = ?").bind(email).run();
}

function userRow(agents: Agents, email: string) {
	return agents.db
		.prepare("SELECT id, name, email_verified FROM user WHERE email = ?")
		.bind(email)
		.first<{ id: string; name: string; email_verified: number }>();
}

function providerAccount(agents: Agents, sub: string) {
	return agents.db
		.prepare("SELECT * FROM account WHERE provider_id = 'oidc' AND account_id = ?")
		.bind(sub)
		.first<Record<string, unknown> & { user_id: string }>();
}

async function sessionIdsOf(agents: Agents, userId: string) {
	const { results } = await agents.db
		.prepare("SELECT oidc_sid FROM session WHERE user_id = ?")
		.bind(userId)
		.all();
	return results.map((row: { oidc_sid: string | null }) => row.oidc_sid);
}

describe("signing in through a provider", () => {
	let agents: Agents;
	let provider: Provider;

	beforeAll(async () => {
		provider = await standInProvider();
		agents = await startAgents(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	it("makes an account for someone new, with a verified address", async () => {
		const email = "new@oidc.test";
		const { location, cookie } = await signIn(agents, provider, {
			sub: "sub-new",
			email,
			sid: "sid-new",
		});

		expect(location.pathname).toBe("/");
		const session = await sessionOf(agents, cookie);
		expect(session?.user).toMatchObject({ email, name: "Pat Provider", emailVerified: true });
		expect((await providerAccount(agents, "sub-new"))?.user_id).toBe(session?.user.id);
	});

	it("keeps none of the provider's tokens, the first time or the next", async () => {
		const person = { sub: "sub-tokens", email: "tokens@oidc.test" };
		const noTokens = {
			access_token: null,
			refresh_token: null,
			id_token: null,
			access_token_expires_at: null,
			refresh_token_expires_at: null,
		};

		await signIn(agents, provider, person);
		expect(await providerAccount(agents, person.sub)).toMatchObject(noTokens);

		await signIn(agents, provider, person);
		expect(await providerAccount(agents, person.sub)).toMatchObject(noTokens);
	});

	it("signs them in to the same account again, with the provider's new session", async () => {
		const person = { sub: "sub-again", email: "again@oidc.test" };
		const first = await signIn(agents, provider, { ...person, sid: "sid-first" });
		const second = await signIn(agents, provider, { ...person, sid: "sid-second" });

		const firstUser = await sessionOf(agents, first.cookie);
		const secondUser = await sessionOf(agents, second.cookie);
		expect(secondUser?.user.id).toBe(firstUser?.user.id);
		expect(await sessionIdsOf(agents, secondUser?.user.id ?? "")).toEqual(
			expect.arrayContaining(["sid-first", "sid-second"]),
		);
	});

	it("does not tell the browser which of the provider's sessions it came from", async () => {
		const { cookie } = await signIn(agents, provider, {
			sub: "sub-private",
			email: "private@oidc.test",
			sid: "sid-private",
		});
		const session = await sessionOf(agents, cookie);
		expect(session?.session).toBeDefined();
		expect(JSON.stringify(session)).not.toContain("sid-private");
	});

	it("does not let a browser say which of the provider's sessions it came from", async () => {
		const client = newClient();
		const { cookie } = await signIn(
			agents,
			provider,
			{ sub: "sub-claims", email: "claims@oidc.test", sid: "sid-claims" },
			client,
		);

		await authApi(agents, "/update-session", { client, cookie, body: { oidcSid: "sid-other" } });

		const user = await userRow(agents, "claims@oidc.test");
		expect(await sessionIdsOf(agents, user?.id ?? "")).toEqual(["sid-claims"]);
	});

	it("keeps sign-ins running at once apart", async () => {
		const people = Array.from({ length: 8 }, (_, i) => ({
			sub: `sub-at-once-${i}`,
			email: `at-once-${i}@oidc.test`,
			sid: `sid-at-once-${i}`,
		}));
		await Promise.all(people.map((person) => signIn(agents, provider, person)));
		for (const person of people) {
			const user = await userRow(agents, person.email);
			expect(await sessionIdsOf(agents, user?.id ?? "")).toEqual([person.sid]);
		}
	});

	it("falls back on the email for a name the provider does not give", async () => {
		const email = "nameless@oidc.test";
		await signIn(agents, provider, { sub: "sub-nameless", email, name: "" });
		expect((await userRow(agents, email))?.name).toBe(email);
	});

	it("asks the provider for what the ID token leaves out", async () => {
		const client = newClient();
		const email = "userinfo@oidc.test";
		const { authorize, cookie } = await pressButton(agents, client);
		const code = provider.grant(
			authorize,
			{ sub: "sub-userinfo", sid: "sid-userinfo" },
			{ userInfo: { sub: "sub-userinfo", email, email_verified: true, name: "Una Info" } },
		);
		const back = await comeBack(agents, client, authorize, cookie, code);

		const session = await sessionOf(agents, back.cookie);
		expect(session?.user).toMatchObject({ email, name: "Una Info", emailVerified: true });
		expect(await sessionIdsOf(agents, session?.user.id ?? "")).toEqual(["sid-userinfo"]);
	});

	it("leaves the provider alone when someone signs out of Agents", async () => {
		const client = newClient();
		const { cookie } = await signIn(agents, provider, {
			sub: "sub-signs-out",
			email: "signs-out@oidc.test",
		});
		const response = await authApi(agents, "/sign-out", { client, cookie, body: {} });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(await isSignedIn(agents, cookie)).toBe(false);
	});

	describe("an account that already has the address", () => {
		it("links when both sides have verified it", async () => {
			const email = "links@oidc.test";
			const password = await signUpWithPassword(agents, email);
			await verifyAddress(agents, email);

			const { cookie, location } = await signIn(agents, provider, { sub: "sub-links", email });

			expect(location.searchParams.get("error")).toBeNull();
			const user = await sessionOf(agents, password);
			expect((await sessionOf(agents, cookie))?.user.id).toBe(user?.user.id);
			expect((await providerAccount(agents, "sub-links"))?.user_id).toBe(user?.user.id);
		});

		it("is left alone when the provider has not verified it", async () => {
			const email = "provider-unverified@oidc.test";
			await signUpWithPassword(agents, email);
			await verifyAddress(agents, email);

			const { cookie, location } = await signIn(agents, provider, {
				sub: "sub-provider-unverified",
				email,
				email_verified: false,
			});

			expect(location.pathname).toBe("/login");
			expect(location.searchParams.get("error")).toBe("account_not_linked");
			expect(await isSignedIn(agents, cookie)).toBe(false);
			expect(await providerAccount(agents, "sub-provider-unverified")).toBeNull();
		});

		it("is left alone when the provider says so only in words", async () => {
			const email = "provider-words@oidc.test";
			await signUpWithPassword(agents, email);
			await verifyAddress(agents, email);

			const { cookie, location } = await signIn(agents, provider, {
				sub: "sub-provider-words",
				email,
				email_verified: "false",
			});

			expect(location.searchParams.get("error")).toBe("account_not_linked");
			expect(await isSignedIn(agents, cookie)).toBe(false);
		});

		it("is left alone when Agents has not verified it", async () => {
			const email = "agents-unverified@oidc.test";
			await signUpWithPassword(agents, email);

			const { cookie, location } = await signIn(agents, provider, {
				sub: "sub-agents-unverified",
				email,
			});

			expect(location.searchParams.get("error")).toBe("account_not_linked");
			expect(await isSignedIn(agents, cookie)).toBe(false);
			expect(await providerAccount(agents, "sub-agents-unverified")).toBeNull();
		});
	});

	describe("an ID token that does not hold up", () => {
		const cases: [string, JWTPayload, "stranger"?][] = [
			["signed with another key", {}, "stranger"],
			["from another issuer", { iss: "https://elsewhere.test" }],
			["for another app", { aud: "another-client" }],
			["for another sign-in", { nonce: "another-nonce" }],
			["with no nonce", { nonce: undefined }],
			["expired", { exp: Math.floor(Date.now() / 1000) - 600 }],
		];

		it.each(cases)("refuses one %s", async (name, claims, signer) => {
			const client = newClient();
			const sub = `sub-${name.replaceAll(" ", "-")}`;
			const email = `${sub}@oidc.test`;
			const { authorize, cookie } = await pressButton(agents, client);
			const code = provider.grant(
				authorize,
				{ sub, email, email_verified: true, ...claims },
				signer ? { key: await provider.strangerKey() } : {},
			);

			const back = await comeBack(agents, client, authorize, cookie, code);

			expect(back.location.pathname).toBe("/login");
			expect(back.location.searchParams.get("error")).toBeTruthy();
			expect(await isSignedIn(agents, back.cookie)).toBe(false);
			expect(await userRow(agents, email)).toBeNull();
		});
	});

	it("refuses a code that came back on someone else's cookie", async () => {
		const client = newClient();
		const email = "stolen-state@oidc.test";
		const { authorize } = await pressButton(agents, client);
		const code = provider.grant(authorize, { sub: "sub-stolen", email, email_verified: true });
		const other = await pressButton(agents, client);

		const back = await comeBack(agents, client, authorize, other.cookie, code);

		expect(back.location.searchParams.get("error")).toBeTruthy();
		expect(await isSignedIn(agents, back.cookie)).toBe(false);
		expect(await userRow(agents, email)).toBeNull();
	});
});

describe("a provider that is not answering", () => {
	it("costs nothing but its own button, which works once it is back", async () => {
		const provider = await standInProvider();
		provider.go("down");
		const agents = await startAgents(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
		try {
			const client = newClient();
			const email = "password-while-down@oidc.test";
			const cookie = await signUpWithPassword(agents, email, client);
			expect((await sessionOf(agents, cookie))?.user.email).toBe(email);
			const again = await authApi(agents, "/sign-in/email", {
				client,
				body: { email, password: PASSWORD },
			});
			expect(again.status).toBe(200);
			const page = await agents.fetch(`${origin}/login`);
			expect(page.status).toBe(200);
			// None of that asked it anything.
			expect(provider.requests).toEqual([]);

			const pressed = await authApi(agents, "/sign-in/social", {
				client: newClient(),
				body: { provider: "oidc", callbackURL: "/" },
			});
			expect(pressed.status).toBe(404);
			expect(await pressed.json()).toMatchObject({ code: "PROVIDER_NOT_FOUND" });
			expect(provider.requests).toEqual(["/.well-known/openid-configuration"]);

			provider.go("up");
			const back = await signIn(agents, provider, {
				sub: "sub-back-up",
				email: "back-up@oidc.test",
			});
			expect(await isSignedIn(agents, back.cookie)).toBe(true);
		} finally {
			await agents.dispose();
		}
	});

	it("offers nothing when the provider has no keys to check its tokens with", async () => {
		const provider = await standInProvider();
		provider.go("no-keys");
		const agents = await startAgents(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
		try {
			const pressed = await authApi(agents, "/sign-in/social", {
				client: newClient(),
				body: { provider: "oidc", callbackURL: "/" },
			});
			expect(pressed.status).toBe(404);
		} finally {
			await agents.dispose();
		}
	});

	it("keeps someone waiting at most 10 seconds, and nobody else at all", async () => {
		const provider = await standInProvider();
		provider.go("hanging");
		const agents = await startAgents(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
		try {
			const started = Date.now();
			const waiting = authApi(agents, "/sign-in/social", {
				client: newClient(),
				body: { provider: "oidc", callbackURL: "/" },
			});
			await vi.waitFor(() => expect(provider.requests).not.toEqual([]));

			const email = "password-while-hanging@oidc.test";
			const cookie = await signUpWithPassword(agents, email);
			expect((await sessionOf(agents, cookie))?.user.email).toBe(email);
			expect(Date.now() - started).toBeLessThan(9_000);

			const pressed = await waiting;
			expect(pressed.status).toBe(404);
			expect(Date.now() - started).toBeLessThan(15_000);
		} finally {
			await agents.dispose();
		}
	});
});

describe("signing out at the provider", () => {
	let agents: Agents;
	let provider: Provider;

	beforeAll(async () => {
		provider = await standInProvider();
		agents = await startAgents(origin, {
			isolates: 2,
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	/** The provider delivers a logout token. No cookie and no Origin: it is not a browser. */
	function deliver(token: string | undefined, { isolate = 0, id = "oidc" } = {}) {
		return agents.fetchIn(isolate, `${origin}/api/auth/backchannel-logout/${id}`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"cf-connecting-ip": newClient(),
			},
			body: new URLSearchParams(token === undefined ? {} : { logout_token: token }).toString(),
		});
	}

	it("ends the session a token names, and no other of theirs", async () => {
		const person = { sub: "sub-by-sid", email: "by-sid@oidc.test" };
		const ended = await signIn(agents, provider, { ...person, sid: "sid-ended" });
		const kept = await signIn(agents, provider, { ...person, sid: "sid-kept" });

		const response = await deliver(
			await provider.logoutToken({ sub: person.sub, sid: "sid-ended" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await isSignedIn(agents, ended.cookie)).toBe(false);
		expect(await isSignedIn(agents, kept.cookie)).toBe(true);
	});

	it("finds a session by its id alone, when that is all a token says", async () => {
		const { cookie } = await signIn(agents, provider, {
			sub: "sub-sid-only",
			email: "sid-only@oidc.test",
			sid: "sid-only",
		});

		expect((await deliver(await provider.logoutToken({ sid: "sid-only" }))).status).toBe(200);

		expect(await isSignedIn(agents, cookie)).toBe(false);
	});

	it("does not end someone's session for a token about somebody else", async () => {
		const { cookie } = await signIn(agents, provider, {
			sub: "sub-bystander",
			email: "bystander@oidc.test",
			sid: "sid-bystander",
		});
		await signIn(agents, provider, {
			sub: "sub-other",
			email: "other@oidc.test",
			sid: "sid-other",
		});

		const response = await deliver(
			await provider.logoutToken({ sub: "sub-other", sid: "sid-bystander" }),
		);

		expect(response.status).toBe(200);
		expect(await isSignedIn(agents, cookie)).toBe(true);
	});

	it("ends all of someone's sessions when a token names only them", async () => {
		const email = "by-sub@oidc.test";
		const password = await signUpWithPassword(agents, email);
		await verifyAddress(agents, email);
		const person = { sub: "sub-by-sub", email };
		const first = await signIn(agents, provider, { ...person, sid: "sid-sub-1" });
		const second = await signIn(agents, provider, { ...person, sid: "sid-sub-2" });
		const bystander = await signIn(agents, provider, {
			sub: "sub-next-door",
			email: "next-door@oidc.test",
			sid: "sid-next-door",
		});

		expect((await deliver(await provider.logoutToken({ sub: person.sub }))).status).toBe(200);

		expect(await isSignedIn(agents, first.cookie)).toBe(false);
		expect(await isSignedIn(agents, second.cookie)).toBe(false);
		expect(await isSignedIn(agents, password)).toBe(false);
		expect(await isSignedIn(agents, bystander.cookie)).toBe(true);
	});

	it("answers 200 about someone it does not know, and ends nothing", async () => {
		const { cookie } = await signIn(agents, provider, {
			sub: "sub-known",
			email: "known@oidc.test",
			sid: "sid-known",
		});

		const response = await deliver(
			await provider.logoutToken({ sub: "sub-nobody", sid: "sid-known" }),
		);

		expect(response.status).toBe(200);
		expect(await isSignedIn(agents, cookie)).toBe(true);
	});

	it("works in an isolate that has never seen a sign-in", async () => {
		const { cookie } = await signIn(agents, provider, {
			sub: "sub-cold",
			email: "cold@oidc.test",
			sid: "sid-cold",
		});

		const response = await deliver(
			await provider.logoutToken({ sub: "sub-cold", sid: "sid-cold" }),
			{ isolate: 1 },
		);

		expect(response.status).toBe(200);
		expect(await isSignedIn(agents, cookie)).toBe(false);
	});

	it("takes a token that leaves out its type", async () => {
		const { cookie } = await signIn(agents, provider, {
			sub: "sub-no-typ",
			email: "no-typ@oidc.test",
			sid: "sid-no-typ",
		});
		const token = await provider.logoutToken({ sid: "sid-no-typ" }, { typ: "" });

		expect((await deliver(token)).status).toBe(200);
		expect(await isSignedIn(agents, cookie)).toBe(false);
	});

	describe("a token that does not hold up", () => {
		const now = () => Math.floor(Date.now() / 1000);
		const victim = { sub: "sub-victim", email: "victim@oidc.test", sid: "sid-victim" };
		const named = { sub: victim.sub, sid: victim.sid };
		let victimCookie: string;

		beforeAll(async () => {
			victimCookie = (await signIn(agents, provider, victim)).cookie;
		});

		const cases: [string, () => Promise<string>][] = [
			[
				"signed with another key",
				async () => provider.logoutToken(named, { key: await provider.strangerKey() }),
			],
			["from another issuer", () => provider.logoutToken({ ...named, iss: "https://x.test" })],
			["for another app", () => provider.logoutToken({ ...named, aud: "another-client" })],
			["of another type", () => provider.logoutToken(named, { typ: "JWT" })],
			["with no event", () => provider.logoutToken({ ...named, events: undefined })],
			[
				"with another event",
				() => provider.logoutToken({ ...named, events: { "https://x.test/event": {} } }),
			],
			["with a nonce", () => provider.logoutToken({ ...named, nonce: "a-nonce" })],
			["naming nobody", () => provider.logoutToken({})],
			["expired", () => provider.logoutToken({ ...named, exp: now() - 600, iat: now() - 900 })],
			["made long ago", () => provider.logoutToken({ ...named, iat: now() - 3600 })],
			["with no date", () => provider.logoutToken({ ...named, iat: undefined })],
			["with no expiry", () => provider.logoutToken({ ...named, exp: undefined })],
			[
				"that is really an ID token",
				() =>
					provider.sign({
						iss: OIDC.issuer,
						aud: OIDC.clientId,
						iat: now(),
						exp: now() + 60,
						nonce: "a-nonce",
						...named,
					}),
			],
			[
				"not signed at all",
				async () => {
					const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
					return `${part({ alg: "none", typ: "logout+jwt" })}.${part({
						iss: OIDC.issuer,
						aud: OIDC.clientId,
						iat: now(),
						exp: now() + 60,
						events: { [LOGOUT_EVENT]: {} },
						...named,
					})}.`;
				},
			],
			["that is no token", async () => "not-a-token"],
		];

		it.each(cases)("refuses one %s", async (_name, make) => {
			const response = await deliver(await make());

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_request" });
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await isSignedIn(agents, victimCookie)).toBe(true);
		});

		it("refuses a request with no token", async () => {
			expect((await deliver(undefined)).status).toBe(400);
		});

		it("refuses another provider's address", async () => {
			const token = await provider.logoutToken(named);
			expect((await deliver(token, { id: "github" })).status).toBe(404);
			expect(await isSignedIn(agents, victimCookie)).toBe(true);
		});

		it("takes only the form a provider sends", async () => {
			const response = await agents.fetch(`${origin}/api/auth/backchannel-logout/oidc`, {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": newClient() },
				body: JSON.stringify({ logout_token: await provider.logoutToken(named) }),
			});
			expect(response.status).toBe(415);
			expect(await isSignedIn(agents, victimCookie)).toBe(true);
		});
	});
});

describe("the sign-in page", () => {
	let agents: Agents;
	let provider: Provider;

	const { OIDC_PROVIDER_NAME: _name, ...unnamed } = OIDC_VARS;
	const { OIDC_CLIENT_SECRET: _secret, ...incomplete } = OIDC_VARS;

	beforeAll(async () => {
		provider = await standInProvider();
		agents = await startAgents(origin, {
			isolates: 4,
			isolateSettings: [{}, OIDC_VARS, unnamed, incomplete],
			hosts: providerHost(provider),
		});
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	async function page(isolate: number, query = "") {
		const response = await agents.fetchIn(isolate, `${origin}/login${query}`);
		expect(response.status).toBe(200);
		return response.text();
	}

	it("has no button without a provider", async () => {
		expect(await page(0)).not.toContain("Continue with");
	});

	it("calls the button what the settings say", async () => {
		expect(await page(1)).toContain("Continue with Gateweave");
	});

	it("has a name for a provider that was not given one", async () => {
		expect(await page(2)).toContain("Continue with single sign-on");
	});

	it("has no button with part of the settings", async () => {
		expect(await page(3)).not.toContain("Continue with");
	});

	it("does not offer the provider's way in without a provider", async () => {
		const response = await agents.fetchIn(0, `${origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { origin, "content-type": "application/json", "cf-connecting-ip": newClient() },
			body: JSON.stringify({ provider: "oidc", callbackURL: "/" }),
		});
		expect(response.status).toBe(404);
		const logout = await agents.fetchIn(0, `${origin}/api/auth/backchannel-logout/oidc`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "logout_token=x",
		});
		expect(logout.status).toBe(404);
		expect(provider.requests).toEqual([]);
	});

	it("explains a refusal in its own words", async () => {
		expect(await page(1, "?error=account_not_linked")).toContain("already has an account");
		const made = await page(1, `?error=${encodeURIComponent("Call this number")}`);
		// What the page says, since the router also carries its query along in a script.
		const said = /role="alert"[^>]*>([^<]*)</.exec(made)?.[1];
		expect(said).toContain("did not work");
		expect(said).not.toContain("Call this number");
	});
});
