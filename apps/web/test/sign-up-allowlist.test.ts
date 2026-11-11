import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgents } from "./agents-worker";
import { OIDC, OIDC_VARS, standInProvider } from "./oidc-provider";

// Who may make an account (AGT-106): the server owner's list, invitations to a workspace, the first
// account of a new server, and the sign-in provider where the owner trusts it. Every path that makes
// an account must refuse an address with no way in, in the same words, and the database must refuse
// it too when a path forgets to ask.

const origin = "https://agents.test";
const PASSWORD = "a-long-test-password";
const CLOSED_WORDS =
	"This server takes new accounts by invitation. Ask whoever runs it to invite you.";
const GITHUB_SECRET = "github-secret-for-tests";

type Agents = Awaited<ReturnType<typeof startAgents>>;
type Provider = Awaited<ReturnType<typeof standInProvider>>;

/** Every request comes from an address of its own, because sign-ups are limited per address. */
let requests = 0;
function newClient() {
	requests += 1;
	return `10.9.${Math.floor(requests / 250)}.${(requests % 250) + 1}`;
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

interface Call {
	cookie?: string;
	body?: object;
	query?: Record<string, string>;
	method?: "GET" | "POST";
}

function api(agents: Agents, path: string, { cookie, body, query, method }: Call = {}) {
	const search = query ? `?${new URLSearchParams(query)}` : "";
	return agents.fetch(`${origin}/api/auth${path}${search}`, {
		method: method ?? (body ? "POST" : "GET"),
		headers: {
			origin,
			"cf-connecting-ip": newClient(),
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		...(body && { body: JSON.stringify(body) }),
	});
}

function signUp(agents: Agents, email: string) {
	return api(agents, "/sign-up/email", {
		body: { name: "Sam Sample", email, password: PASSWORD },
	});
}

/** Signs someone up and returns their cookie. */
async function signedUp(agents: Agents, email: string) {
	const response = await signUp(agents, email);
	expect(response.status).toBe(200);
	return cookieOf(response);
}

async function expectClosed(response: Response) {
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ code: "SIGN_UP_CLOSED", message: CLOSED_WORDS });
}

async function expectRefused(response: Response, status: number, code: string) {
	expect(response.status).toBe(status);
	// A path that does not exist for the caller answers without a body.
	if (status !== 404 || code !== "NOT_FOUND") {
		expect(((await response.json()) as { code?: string }).code).toBe(code);
	}
}

async function userId(agents: Agents, email: string) {
	const row = await agents.db
		.prepare("SELECT id FROM user WHERE email = ?")
		.bind(email)
		.first<{ id: string }>();
	return row?.id ?? null;
}

async function hasAccount(agents: Agents, email: string) {
	return (await userId(agents, email)) !== null;
}

let inserted = 0;
/** Makes a user row the way a path that forgot to ask would. */
function insertUser(agents: Agents, email: string, verified = false) {
	inserted += 1;
	return agents.db
		.prepare("INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, ?)")
		.bind(`raw-${inserted}`, "Raw", email, verified ? 1 : 0)
		.run();
}

interface Listing {
	signUp: "open" | "closed";
	trustProvider: boolean;
	hasProvider: boolean;
	total: number;
	matching: number;
	entries: { entry: string; note: string | null; addedAt: number; hasAccount: boolean }[];
}

async function listing(agents: Agents, cookie: string, query?: Record<string, string>) {
	const response = await api(agents, "/deployment/get", { cookie, ...(query && { query }) });
	expect(response.status).toBe(200);
	return (await response.json()) as Listing;
}

async function setSignUp(agents: Agents, cookie: string, signUp: "open" | "closed") {
	const response = await api(agents, "/deployment/sign-up", { cookie, body: { signUp } });
	expect(response.status).toBe(200);
}

async function allow(agents: Agents, cookie: string, entry: string, note?: string) {
	return api(agents, "/deployment/allow/add", {
		cookie,
		body: { entry, ...(note !== undefined && { note }) },
	});
}

async function makeStale(agents: Agents, email: string) {
	await agents.db
		.prepare(
			"UPDATE session SET created_at = ? WHERE user_id = (SELECT id FROM user WHERE email = ?)",
		)
		.bind(Date.now() - 3 * 24 * 60 * 60 * 1000, email)
		.run();
}

describe("a server that has an owner", () => {
	let agents: Agents;
	let owner: string;

	beforeAll(async () => {
		agents = await startAgents(origin, {
			settings: { SIGN_UP_REQUEST_URL: "https://gateweave.example/waitlist" },
		});
		owner = await signedUp(agents, "owner@owner.test");
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	it("is owned by its first account, and takes anyone by default", async () => {
		const row = await agents.db
			.prepare("SELECT owner_id, sign_up, trust_provider FROM deployment WHERE id = 1")
			.first<{ owner_id: string; sign_up: string; trust_provider: number }>();
		expect(row).toEqual({
			owner_id: await userId(agents, "owner@owner.test"),
			sign_up: "open",
			trust_provider: 0,
		});
		expect(await signedUp(agents, "anyone@anywhere.test")).toContain("session_token");
	});

	it("keeps taking anyone while sign-up is open, whatever the list says", async () => {
		expect((await listing(agents, owner)).signUp).toBe("open");
		expect((await signUp(agents, "open@stranger.test")).status).toBe(200);
	});

	describe("once sign-up is closed", () => {
		beforeAll(async () => {
			await setSignUp(agents, owner, "closed");
		});

		it("refuses an address that is not on the list, in words that say nothing about it", async () => {
			await expectClosed(await signUp(agents, "stranger@nowhere.test"));
			expect(await hasAccount(agents, "stranger@nowhere.test")).toBe(false);
		});

		it("refuses an address that has an account in the same words as one that has none", async () => {
			// Better Auth would otherwise say that this address is taken.
			await expectClosed(await signUp(agents, "anyone@anywhere.test"));
			await expectClosed(await signUp(agents, "ANYONE@ANYWHERE.TEST"));
		});

		it("lets an address on the list make an account, however it was typed", async () => {
			expect((await allow(agents, owner, "  Ada@Example.COM ")).status).toBe(200);
			expect((await signUp(agents, "ada@example.com")).status).toBe(200);
			expect((await allow(agents, owner, "grace@example.com")).status).toBe(200);
			expect((await signUp(agents, "Grace@Example.com")).status).toBe(200);
		});

		it("lets anyone at a listed domain make an account, but not at its subdomains", async () => {
			expect((await allow(agents, owner, "@corp.test")).status).toBe(200);
			expect((await signUp(agents, "someone@corp.test")).status).toBe(200);
			expect((await signUp(agents, "SOMEONE.ELSE@CORP.TEST")).status).toBe(200);
			await expectClosed(await signUp(agents, "someone@mail.corp.test"));
			await expectClosed(await signUp(agents, "someone@notcorp.test"));
			await expectClosed(await signUp(agents, "someone@corp.test.evil.test"));
			expect(await hasAccount(agents, "someone@mail.corp.test")).toBe(false);
		});

		it("does not take the domain of one address for the address of another", async () => {
			expect((await allow(agents, owner, "only@one.test")).status).toBe(200);
			await expectClosed(await signUp(agents, "other@one.test"));
		});

		it("stops letting an address in once it comes off the list", async () => {
			expect((await allow(agents, owner, "briefly@list.test")).status).toBe(200);
			const removed = await api(agents, "/deployment/allow/remove", {
				cookie: owner,
				body: { entry: "briefly@list.test" },
			});
			expect(removed.status).toBe(200);
			await expectClosed(await signUp(agents, "briefly@list.test"));
		});

		it("still lets an address with a pending invitation to a workspace make an account", async () => {
			const created = await api(agents, "/organization/create", {
				cookie: owner,
				body: { name: "Team", slug: "team" },
			});
			expect(created.status).toBe(200);
			const { id: organizationId } = (await created.json()) as { id: string };
			const invite = (email: string) =>
				api(agents, "/organization/invite-member", {
					cookie: owner,
					body: { email, role: "member", organizationId },
				});

			expect((await invite("Invited@Guests.test")).status).toBe(200);
			expect((await signUp(agents, "invited@guests.test")).status).toBe(200);

			// An invitation that has run out, or was taken back, lets nobody in.
			expect((await invite("late@guests.test")).status).toBe(200);
			await agents.db
				.prepare("UPDATE invitation SET expires_at = ? WHERE email = ?")
				.bind(Date.now() - 1000, "late@guests.test")
				.run();
			await expectClosed(await signUp(agents, "late@guests.test"));

			expect((await invite("taken-back@guests.test")).status).toBe(200);
			await agents.db
				.prepare("UPDATE invitation SET status = 'canceled' WHERE email = ?")
				.bind("taken-back@guests.test")
				.run();
			await expectClosed(await signUp(agents, "taken-back@guests.test"));
		});

		it("lets an invited person accept, and join the workspace", async () => {
			const created = await api(agents, "/organization/create", {
				cookie: owner,
				body: { name: "Joiners", slug: "joiners" },
			});
			const { id: organizationId } = (await created.json()) as { id: string };
			const invited = await api(agents, "/organization/invite-member", {
				cookie: owner,
				body: { email: "joiner@guests.test", role: "member", organizationId },
			});
			const { id: invitationId } = (await invited.json()) as { id: string };
			const cookie = await signedUp(agents, "joiner@guests.test");
			// Email is on here, so the plugin wants the invited address verified before it lets them in.
			await agents.db
				.prepare("UPDATE user SET email_verified = 1 WHERE email = 'joiner@guests.test'")
				.run();
			const accepted = await api(agents, "/organization/accept-invitation", {
				cookie,
				body: { invitationId },
			});
			expect(accepted.status).toBe(200);
			const member = await agents.db
				.prepare("SELECT 1 AS found FROM member WHERE organization_id = ? AND user_id = ?")
				.bind(organizationId, await userId(agents, "joiner@guests.test"))
				.first();
			expect(member).not.toBeNull();
		});

		it("refuses at the database an address with no way in, if a path forgot to ask", async () => {
			// What a path that forgot to ask would meet: the database itself.
			await expect(insertUser(agents, "raw@nowhere.test")).rejects.toThrow(
				/sign-up is closed here/,
			);
			expect(await hasAccount(agents, "raw@nowhere.test")).toBe(false);
			await expect(insertUser(agents, "RAW@Nowhere.test", true)).rejects.toThrow(
				/sign-up is closed here/,
			);
		});

		it("holds the list in the database too, with the domain from the last @", async () => {
			await insertUser(agents, "raw@corp.test");
			await insertUser(agents, "raw@only.one.test").then(
				() => {
					throw new Error("a subdomain of a listed address got in");
				},
				() => undefined,
			);
			await expect(insertUser(agents, "raw@mail.corp.test")).rejects.toThrow(
				/sign-up is closed here/,
			);
			await insertUser(agents, "raw@one.test").then(
				() => {
					throw new Error("another address at the domain of a listed address got in");
				},
				() => undefined,
			);
			await insertUser(agents, "only@one.test");
		});

		it("takes a pending invitation at the database too", async () => {
			await expect(insertUser(agents, "raw-invited@guests.test")).rejects.toThrow(
				/sign-up is closed here/,
			);
			const workspace = await agents.db
				.prepare("SELECT id FROM organization LIMIT 1")
				.first<{ id: string }>();
			const inviter = await userId(agents, "owner@owner.test");
			await agents.db
				.prepare(
					"INSERT INTO invitation (id, organization_id, email, role, status, expires_at, inviter_id) VALUES ('inv-raw', ?, 'raw-invited@guests.test', 'member', 'pending', ?, ?)",
				)
				.bind(workspace?.id, Date.now() + 60_000, inviter)
				.run();
			await insertUser(agents, "raw-invited@guests.test");
		});

		it("shows the sign-in page where to ask for access", async () => {
			const page = await (await agents.fetch(`${origin}/login`)).text();
			expect(page).toContain("Ask for access");
			expect(page).toContain('href="https://gateweave.example/waitlist"');
		});

		it("does not let the owner's account go while sign-up is closed", async () => {
			const refused = await api(agents, "/account/delete", {
				cookie: owner,
				body: { password: PASSWORD },
			});
			await expectRefused(refused, 403, "RUNS_THE_SERVER");
			await expect(
				agents.db.prepare("DELETE FROM user WHERE email = 'owner@owner.test'").run(),
			).rejects.toThrow(/a server must keep its owner/);
		});
	});

	describe("what the owner sees and does", () => {
		let other: string;

		beforeAll(async () => {
			await setSignUp(agents, owner, "open");
			other = await signedUp(agents, "other@owner.test");
			await setSignUp(agents, owner, "closed");
		});

		it("shows the page no link while sign-up is open", async () => {
			await setSignUp(agents, owner, "open");
			const page = await (await agents.fetch(`${origin}/login`)).text();
			expect(page).not.toContain("Ask for access");
			await setSignUp(agents, owner, "closed");
		});

		it("answers anyone else with not found, on every path", async () => {
			const paths = [
				["/deployment/sign-up", { signUp: "open" }],
				["/deployment/trust-provider", { trust: true }],
				["/deployment/allow/add", { entry: "x@y.test" }],
				["/deployment/allow/remove", { entry: "x@y.test" }],
			] as const;
			for (const [path, body] of paths) {
				await expectRefused(await api(agents, path, { cookie: other, body }), 404, "NOT_FOUND");
			}
			await expectRefused(
				await api(agents, "/deployment/get", { cookie: other }),
				404,
				"NOT_FOUND",
			);
			const signedOut = await api(agents, "/deployment/get");
			expect(signedOut.status).toBe(401);
			expect((await listing(agents, owner)).signUp).toBe("closed");
		});

		it("asks for a recent sign-in before changing anything", async () => {
			await makeStale(agents, "owner@owner.test");
			expect((await api(agents, "/deployment/get", { cookie: owner })).status).toBe(200);
			const attempts = [
				["/deployment/sign-up", { signUp: "open" }],
				["/deployment/allow/add", { entry: "stale@list.test" }],
				["/deployment/allow/remove", { entry: "ada@example.com" }],
			] as const;
			for (const [path, body] of attempts) {
				await expectRefused(
					await api(agents, path, { cookie: owner, body }),
					403,
					"SESSION_NOT_FRESH",
				);
			}
			const state = await listing(agents, owner);
			expect(state.signUp).toBe("closed");
			expect(state.entries.map(({ entry }) => entry)).toContain("ada@example.com");
			expect(state.entries.map(({ entry }) => entry)).not.toContain("stale@list.test");

			// Signing in again makes a fresh one.
			const again = await api(agents, "/sign-in/email", {
				body: { email: "owner@owner.test", password: PASSWORD },
			});
			expect(again.status).toBe(200);
			owner = cookieOf(again);
			expect((await allow(agents, owner, "fresh@list.test")).status).toBe(200);
		});

		it("adds an entry in lowercase with its note, and says whether it has an account", async () => {
			expect((await allow(agents, owner, "Noted@Listed.test", "  from the waitlist ")).status).toBe(
				200,
			);
			let state = await listing(agents, owner, { q: "waitlist" });
			expect(state.entries).toEqual([
				expect.objectContaining({
					entry: "noted@listed.test",
					note: "from the waitlist",
					hasAccount: false,
				}),
			]);
			expect(state.matching).toBe(1);

			await signedUp(agents, "noted@listed.test");
			state = await listing(agents, owner, { q: "noted@" });
			expect(state.entries[0]).toMatchObject({ entry: "noted@listed.test", hasAccount: true });
		});

		it("says whether anyone at a listed domain has an account", async () => {
			expect((await allow(agents, owner, "@lonely.test")).status).toBe(200);
			expect((await allow(agents, owner, "@busy.test")).status).toBe(200);
			await signedUp(agents, "person@busy.test");
			const state = await listing(agents, owner, { q: ".test" });
			const byEntry = Object.fromEntries(state.entries.map((row) => [row.entry, row.hasAccount]));
			expect(byEntry["@lonely.test"]).toBe(false);
			expect(byEntry["@busy.test"]).toBe(true);
			// An account at a subdomain is not at the domain.
			expect((await allow(agents, owner, "@sub.test")).status).toBe(200);
			await insertUser(agents, "raw@deep.sub.test").catch(() => undefined);
			expect((await listing(agents, owner, { q: "@sub.test" })).entries[0]?.hasAccount).toBe(false);
		});

		it("refuses what is not an address or a domain, and a long note", async () => {
			for (const entry of [
				"",
				"nope",
				"@",
				"@localhost",
				"@a b.test",
				"@-bad.test",
				"@1.2.3.4",
				"two@@signs.test",
				"@*.test",
				"a b@c.test",
			]) {
				await expectRefused(await allow(agents, owner, entry), 400, "INVALID_REQUEST");
			}
			await expectRefused(
				await allow(agents, owner, "long@note.test", "x".repeat(201)),
				400,
				"INVALID_REQUEST",
			);
			expect((await allow(agents, owner, "long@note.test", "x".repeat(200))).status).toBe(200);
			expect((await allow(agents, owner, "blank@note.test", "   ")).status).toBe(200);
			expect((await listing(agents, owner, { q: "blank@note" })).entries[0]?.note).toBeNull();
		});

		it("does not add an entry twice, and says so", async () => {
			expect((await allow(agents, owner, "twice@list.test")).status).toBe(200);
			await expectRefused(
				await allow(agents, owner, "TWICE@list.test"),
				400,
				"ALREADY_ON_THE_LIST",
			);
		});

		it("removes an entry, and says when there is none", async () => {
			expect((await allow(agents, owner, "gone@list.test")).status).toBe(200);
			const before = (await listing(agents, owner)).total;
			const removed = await api(agents, "/deployment/allow/remove", {
				cookie: owner,
				body: { entry: "Gone@List.test" },
			});
			expect(removed.status).toBe(200);
			expect((await listing(agents, owner)).total).toBe(before - 1);
			await expectRefused(
				await api(agents, "/deployment/allow/remove", {
					cookie: owner,
					body: { entry: "gone@list.test" },
				}),
				404,
				"NOT_ON_THE_LIST",
			);
		});

		it("keeps an account that an entry made when the entry comes off", async () => {
			expect((await allow(agents, owner, "stays@list.test")).status).toBe(200);
			const cookie = await signedUp(agents, "stays@list.test");
			await api(agents, "/deployment/allow/remove", {
				cookie: owner,
				body: { entry: "stays@list.test" },
			});
			const session = await api(agents, "/get-session", { cookie });
			expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
				"stays@list.test",
			);
		});

		it("lists a page at a time, newest first, and searches the whole list", async () => {
			await agents.db
				.prepare(
					"INSERT INTO sign_up_allow (entry, note, added_at, added_by) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) SELECT 'bulk' || i || '@bulk.test', CASE WHEN i = 7 THEN 'the seventh' END, 1000 + i, 'x' FROM n",
				)
				.run();
			const first = await listing(agents, owner, { q: "bulk.test" });
			expect(first.matching).toBe(60);
			expect(first.entries).toHaveLength(50);
			expect(first.entries[0]?.entry).toBe("bulk60@bulk.test");
			expect(first.total).toBeGreaterThanOrEqual(60);
			const rest = await listing(agents, owner, { q: "bulk.test", offset: "50" });
			expect(rest.entries).toHaveLength(10);
			expect(rest.entries.at(-1)?.entry).toBe("bulk1@bulk.test");
			expect((await listing(agents, owner, { q: "seventh" })).entries.map((e) => e.entry)).toEqual([
				"bulk7@bulk.test",
			]);
			// Characters that mean something to a search mean nothing here.
			expect((await listing(agents, owner, { q: "%" })).matching).toBe(0);
			expect((await listing(agents, owner, { q: "_" })).matching).toBe(0);
		});

		it("holds the list to 5,000 entries, in the page and in the database", async () => {
			const total = (await listing(agents, owner)).total;
			await agents.db
				.prepare(
					"INSERT INTO sign_up_allow (entry, added_at, added_by) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT 'fill' || i || '@fill.test', 0, 'x' FROM n",
				)
				.bind(5000 - total)
				.run();
			try {
				expect((await listing(agents, owner)).total).toBe(5000);
				await expectRefused(await allow(agents, owner, "over@list.test"), 400, "LIST_FULL");
				await expect(
					agents.db
						.prepare(
							"INSERT INTO sign_up_allow (entry, added_at, added_by) VALUES ('over@list.test', 0, 'x')",
						)
						.run(),
				).rejects.toThrow(/the sign-up list is full/);
			} finally {
				await agents.db.prepare("DELETE FROM sign_up_allow WHERE entry LIKE '%@fill.test'").run();
			}
		});

		it("opens and closes sign-up", async () => {
			await setSignUp(agents, owner, "open");
			expect((await signUp(agents, "whoever@open.test")).status).toBe(200);
			await setSignUp(agents, owner, "closed");
			await expectClosed(await signUp(agents, "whoever2@open.test"));
			await expectRefused(
				await api(agents, "/deployment/sign-up", { cookie: owner, body: { signUp: "maybe" } }),
				400,
				"INVALID_REQUEST",
			);
		});

		it("does not offer to trust a provider that is not there", async () => {
			expect((await listing(agents, owner)).hasProvider).toBe(false);
			await expectRefused(
				await api(agents, "/deployment/trust-provider", { cookie: owner, body: { trust: true } }),
				404,
				"NOT_FOUND",
			);
		});

		it("lets the owner's account go once sign-up is open, and the server has no owner then", async () => {
			await setSignUp(agents, owner, "open");
			// Only the owner of workspaces has to hand them on first, which is another rule.
			await agents.db.prepare("DELETE FROM organization").run();
			const gone = await api(agents, "/account/delete", {
				cookie: owner,
				body: { password: PASSWORD },
			});
			expect(gone.status).toBe(200);
			const row = await agents.db
				.prepare("SELECT owner_id FROM deployment WHERE id = 1")
				.first<{ owner_id: string | null }>();
			expect(row?.owner_id).toBeNull();
		});
	});
});

describe("the first account on a server", () => {
	let agents: Agents;

	beforeAll(async () => {
		agents = await startAgents(origin, {
			settings: { SIGN_UP_REQUEST_URL: "http://insecure.example/waitlist" },
		});
		await agents.db.prepare("UPDATE deployment SET sign_up = 'closed'").run();
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	it("may be made while sign-up is closed, and owns the server", async () => {
		expect(await signedUp(agents, "first@first.test")).toContain("session_token");
		const row = await agents.db
			.prepare("SELECT owner_id FROM deployment WHERE id = 1")
			.first<{ owner_id: string }>();
		expect(row?.owner_id).toBe(await userId(agents, "first@first.test"));
	});

	it("is the only one that needs no way in", async () => {
		await expectClosed(await signUp(agents, "second@first.test"));
		await expect(insertUser(agents, "second@first.test")).rejects.toThrow(/sign-up is closed here/);
	});

	it("is not offered a way to ask for access at an address that is not https", async () => {
		const page = await (await agents.fetch(`${origin}/login`)).text();
		expect(page).toContain("takes new accounts by invitation");
		expect(page).not.toContain("Ask for access");
		expect(page).not.toContain("insecure.example");
	});
});

describe("a server that was running before the list", () => {
	it("makes its oldest account the owner, and stays open", async () => {
		// The migration fills the row from the accounts there are, so take back what it made on a
		// copy that has some and run its statements again.
		const agents = await startAgents(origin);
		try {
			for (const trigger of [
				"user_needs_a_way_in",
				"first_account_owns_deployment",
				"deployment_keeps_its_owner",
				"sign_up_allow_is_capped",
			]) {
				await agents.db.prepare(`DROP TRIGGER ${trigger}`).run();
			}
			await agents.db.prepare("DELETE FROM deployment").run();
			for (const [id, created] of [
				["newer", 2000],
				["older", 1000],
			] as const) {
				await agents.db
					.prepare("INSERT INTO user (id, name, email, created_at) VALUES (?, ?, ?, ?)")
					.bind(id, id, `${id}@old.test`, created)
					.run();
			}
			const migration = readFileSync(
				join(import.meta.dirname, "../migrations/0007_sign_up_hold.sql"),
				"utf8",
			);
			for (const statement of migration.split("--> statement-breakpoint")) {
				await agents.db.prepare(statement.trim()).run();
			}

			const row = await agents.db
				.prepare("SELECT owner_id, sign_up, trust_provider FROM deployment")
				.first<{ owner_id: string; sign_up: string; trust_provider: number }>();
			expect(row).toEqual({ owner_id: "older", sign_up: "open", trust_provider: 0 });
			// It stays open, so the next person signs up as they always could.
			expect((await signUp(agents, "next@old.test")).status).toBe(200);
		} finally {
			await agents.dispose();
		}
	});
});

describe("signing in through GitHub and a provider", () => {
	let agents: Agents;
	let provider: Provider;
	let owner: string;

	async function gitHubTokens(request: Request) {
		const form = new URLSearchParams(await request.text());
		if (form.get("client_secret") !== GITHUB_SECRET) {
			return Response.json({ error: "incorrect_client_credentials" });
		}
		return Response.json({
			access_token: form.get("code"),
			token_type: "bearer",
			scope: "user:email",
		});
	}

	/** GitHub's API: the access token is the address, so each test can be anyone. */
	function gitHubApi(request: Request) {
		const email = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
		if (new URL(request.url).pathname === "/user") {
			return Response.json({
				id: [...email].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 1_000_000_007,
				login: email.split("@")[0],
				name: "Grace Hopper",
				email,
				avatar_url: "https://avatars.githubusercontent.com/u/1",
			});
		}
		return Response.json([{ email, primary: true, verified: true }]);
	}

	beforeAll(async () => {
		provider = await standInProvider();
		agents = await startAgents(origin, {
			settings: {
				...OIDC_VARS,
				GITHUB_CLIENT_ID: "github-client-for-tests",
				GITHUB_CLIENT_SECRET: GITHUB_SECRET,
			},
			hosts: {
				"github.com": gitHubTokens,
				"api.github.com": gitHubApi,
				[new URL(OIDC.issuer).host]: async (request: Request) =>
					(await provider.outbound(request, new URL(request.url))) ??
					new Response("Not the provider", { status: 502 }),
			},
		});
		owner = await signedUp(agents, "owner@providers.test");
		await setSignUp(agents, owner, "closed");
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	/** The whole way through GitHub as this address. Returns where the browser ends up. */
	async function throughGitHub(email: string) {
		const client = newClient();
		const pressed = await agents.fetch(`${origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
			body: JSON.stringify({
				provider: "github",
				callbackURL: "/",
				errorCallbackURL: "/login",
			}),
		});
		const { url } = (await pressed.json()) as { url: string };
		const query = new URLSearchParams({
			code: email,
			state: new URL(url).searchParams.get("state") ?? "",
		});
		const back = await agents.fetch(`${origin}/api/auth/callback/github?${query}`, {
			headers: { cookie: cookieOf(pressed), "cf-connecting-ip": client },
		});
		return {
			location: new URL(back.headers.get("location") ?? "", origin),
			cookie: cookieOf(back),
		};
	}

	/** The whole way through the OpenID Connect provider as this address. */
	async function throughProvider(email: string) {
		const client = newClient();
		const pressed = await agents.fetch(`${origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
			body: JSON.stringify({ provider: "oidc", callbackURL: "/", errorCallbackURL: "/login" }),
		});
		const { url } = (await pressed.json()) as { url: string };
		const authorize = new URL(url);
		const code = provider.grant(authorize, {
			sub: `sub-${email}`,
			email,
			name: "Pat Provider",
			email_verified: true,
		});
		const query = new URLSearchParams({
			code,
			state: authorize.searchParams.get("state") ?? "",
			iss: OIDC.issuer,
		});
		const back = await agents.fetch(`${origin}/api/auth/callback/oidc?${query}`, {
			headers: { cookie: cookieOf(pressed), "cf-connecting-ip": client },
		});
		return {
			location: new URL(back.headers.get("location") ?? "", origin),
			cookie: cookieOf(back),
		};
	}

	async function setTrust(trust: boolean) {
		const response = await api(agents, "/deployment/trust-provider", {
			cookie: owner,
			body: { trust },
		});
		expect(response.status).toBe(200);
	}

	it("refuses a new person from GitHub, with the same words, and makes no account", async () => {
		const { location, cookie } = await throughGitHub("new@github.test");
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(cookie).not.toContain("session_token");
		expect(await hasAccount(agents, "new@github.test")).toBe(false);
	});

	it("refuses a new person from the provider while it is not trusted", async () => {
		expect((await listing(agents, owner)).hasProvider).toBe(true);
		expect((await listing(agents, owner)).trustProvider).toBe(false);
		const { location } = await throughProvider("new@provider.test");
		expect(location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await hasAccount(agents, "new@provider.test")).toBe(false);
	});

	it("lets an address on the list in through GitHub", async () => {
		expect((await allow(agents, owner, "listed@github.test")).status).toBe(200);
		const { location, cookie } = await throughGitHub("listed@github.test");
		expect(location.searchParams.get("error")).toBeNull();
		expect(cookie).toContain("session_token");
		expect(await hasAccount(agents, "listed@github.test")).toBe(true);
	});

	it("lets anyone in through the provider once the owner trusts it, and GitHub still not", async () => {
		await setTrust(true);
		expect((await listing(agents, owner)).trustProvider).toBe(true);

		const { location, cookie } = await throughProvider("trusted@provider.test");
		expect(location.searchParams.get("error")).toBeNull();
		expect(cookie).toContain("session_token");
		expect(await hasAccount(agents, "trusted@provider.test")).toBe(true);

		const github = await throughGitHub("untrusted@github.test");
		expect(github.location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await hasAccount(agents, "untrusted@github.test")).toBe(false);

		// Nor does it open the way for a password.
		await expectClosed(await signUp(agents, "password@provider.test"));
	});

	it("holds what trust opens to verified addresses in the database", async () => {
		await expect(insertUser(agents, "unverified@raw.test", false)).rejects.toThrow(
			/sign-up is closed here/,
		);
		await insertUser(agents, "verified@raw.test", true);
	});

	it("stops trusting the provider when the owner says so", async () => {
		await setTrust(false);
		const { location } = await throughProvider("again@provider.test");
		expect(location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await hasAccount(agents, "again@provider.test")).toBe(false);
		await expect(insertUser(agents, "verified2@raw.test", true)).rejects.toThrow(
			/sign-up is closed here/,
		);
	});

	it("lets someone who has an account sign in, closed or not", async () => {
		const { location, cookie } = await throughGitHub("listed@github.test");
		expect(location.searchParams.get("error")).toBeNull();
		expect(cookie).toContain("session_token");
	});

	it("takes a trust setting from the owner only, and a fresh sign-in", async () => {
		const { cookie: other } = await throughGitHub("listed@github.test");
		await expectRefused(
			await api(agents, "/deployment/trust-provider", { cookie: other, body: { trust: true } }),
			404,
			"NOT_FOUND",
		);
		await makeStale(agents, "owner@providers.test");
		await expectRefused(
			await api(agents, "/deployment/trust-provider", { cookie: owner, body: { trust: true } }),
			403,
			"SESSION_NOT_FRESH",
		);
	});
});
