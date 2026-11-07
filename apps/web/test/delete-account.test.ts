import type { WebSocket } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAgents } from "./agents-worker";
import { ask } from "./chat-socket";
import { FakeModels } from "./fake-models";

// Deleting an account (AGT-88): the person goes from D1 at once, and every workspace that knew them
// destroys their conversations as soon as it can be reached. What a registry does is tested where it
// lives, in packages/registry/test/forget.test.ts. These go through the real endpoint, to real
// conversations.

const origin = "https://agents.test";
const PASSWORD = "a-long-test-password";
const KEY = "sk-ant-api03-correct-horse-battery";

const models = new FakeModels({ [KEY]: { provider: "anthropic", models: ["claude-sonnet-5-5"] } });

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { models });
});

afterAll(async () => {
	await agents?.dispose();
});

let clients = 0;
/** Each test counts as its own client, so that rate limits stay out of what it is about. */
const newClient = () => `203.0.113.${++clients}`;

function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
	return agents.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			"content-type": "application/json",
			...(init.cookie && { cookie: init.cookie }),
		},
		body: JSON.stringify(init.body ?? {}),
	});
}

async function signUp(client: string, name: string, email: string) {
	const response = await authApi("/sign-up/email", {
		client,
		body: { name, email, password: PASSWORD },
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, email, cookie };
}

async function newWorkspace(client: string, cookie: string, name: string, slug: string) {
	const response = await authApi("/organization/create", { client, cookie, body: { name, slug } });
	expect(response.status).toBe(200);
	return ((await response.json()) as { id: string }).id;
}

async function addMember(workspaceId: string, userId: string, role = "member") {
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, userId, role, Date.now())
		.run();
}

async function count(table: string, column: string, value: string) {
	const row = await agents.db
		.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
		.bind(value)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

const codeOf = async (response: Response) =>
	((await response.json()) as { code?: string; message?: string }).code;

/** A workspace with a key and an agent, which someone can talk to. */
async function workspaceWithAgent(client: string, cookie: string, slug: string) {
	const workspaceId = await newWorkspace(client, cookie, slug, slug);
	const registry = await agents.registry(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Owner");
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	return { workspaceId, registry, agentId: agent.id, slug };
}

/** Has someone say something to the agent over the real socket, and leaves the socket open. */
async function talk(
	workspace: Awaited<ReturnType<typeof workspaceWithAgent>>,
	person: { id: string; cookie: string },
	words: string,
) {
	const conversation = await workspace.registry.startConversation(workspace.agentId, person.id);
	if (!conversation) throw new Error("The conversation did not start");
	const { status, socket } = await agents.connect(
		`${origin}/api/chat/${workspace.slug}/${conversation.id}`,
		{ cookie: person.cookie, origin },
	);
	expect(status).toBe(101);
	if (!socket) throw new Error("No WebSocket");
	expect((await ask(socket, words)).text).toBe("Looks good.");
	return { id: conversation.id, socket };
}

const transcript = async (workspaceId: string, conversationId: string) =>
	(await agents.conversation(workspaceId, conversationId)).transcript();

const closeOf = (socket: WebSocket) =>
	new Promise<number>((resolve) => {
		socket.addEventListener("close", (event) => resolve(event.code));
	});

describe("deleting an account", () => {
	it("needs a session", async () => {
		const response = await authApi("/account/delete", { client: newClient() });
		expect(response.status).toBe(401);
	});

	it("needs the password, and leaves the account alone without it", async () => {
		const client = newClient();
		const person = await signUp(client, "Pat", "pat@delete.test");
		for (const body of [{}, { password: "not-the-password" }]) {
			const refused = await authApi("/account/delete", { client, cookie: person.cookie, body });
			expect(refused.status).toBe(400);
			expect(await codeOf(refused)).toBe("INVALID_PASSWORD");
		}
		expect(await count("user", "id", person.id)).toBe(1);
		expect(await count("session", "user_id", person.id)).toBe(1);
	});

	// Someone holding a stolen cookie would otherwise have a way to guess at the password.
	it("stops counting guesses at five a minute", async () => {
		const client = newClient();
		const person = await signUp(client, "Gus", "gus@delete.test");
		const guess = () =>
			authApi("/account/delete", { client, cookie: person.cookie, body: { password: "a-guess" } });
		for (let tries = 0; tries < 5; tries++) expect((await guess()).status).toBe(400);
		expect((await guess()).status).toBe(429);
		expect(await count("user", "id", person.id)).toBe(1);
	});

	it("refuses a request from another site", async () => {
		const client = newClient();
		const person = await signUp(client, "Ora", "ora@delete.test");
		const response = await agents.fetch(`${origin}/api/auth/account/delete`, {
			method: "POST",
			headers: {
				origin: "https://elsewhere.test",
				"cf-connecting-ip": client,
				"content-type": "application/json",
				cookie: person.cookie,
			},
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(response.status).toBe(403);
		expect(await count("user", "id", person.id)).toBe(1);
	});

	it("needs a session from the last day", async () => {
		const client = newClient();
		const person = await signUp(client, "Sam", "sam@delete.test");
		await agents.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, person.id)
			.run();
		const refused = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe("SESSION_NOT_FRESH");
		expect(await count("user", "id", person.id)).toBe(1);
	});

	it("refuses the only owner of a workspace, and names each one", async () => {
		const client = newClient();
		const person = await signUp(client, "Olu", "olu@delete.test");
		await newWorkspace(client, person.cookie, "Beta Works", "beta-works");
		await newWorkspace(client, person.cookie, "Alpha Works", "alpha-works");

		const refused = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(refused.status).toBe(403);
		const body = (await refused.json()) as { code: string; message: string };
		expect(body.code).toBe("ONLY_OWNER_OF_WORKSPACES");
		expect(body.message).toContain("Alpha Works, Beta Works");
		expect(await count("user", "id", person.id)).toBe(1);
		expect(await count("session", "user_id", person.id)).toBe(1);
		expect(await count("pending_erasure", "user_id", person.id)).toBe(0);
	});

	it("takes the account and destroys their conversations, and nobody else's", async () => {
		const client = newClient();
		const owner = await signUp(client, "Owen", "owen@delete.test");
		const workspace = await workspaceWithAgent(client, owner.cookie, "forgetting");
		const person = await signUp(client, "Lee Leaver", "lee@delete.test");
		await addMember(workspace.workspaceId, person.id);
		const { workspaceId, registry } = workspace;

		const theirs = await talk(workspace, person, "My secret plan");
		const ownersOwn = await talk(workspace, owner, "The owner's own words");
		ownersOwn.socket.close();
		expect(await transcript(workspaceId, theirs.id)).toContain("My secret plan");
		const closed = closeOf(theirs.socket);

		const response = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: true });
		expect(response.headers.getSetCookie().join()).toMatch(/session_token=;/);
		for (const [table, column] of [
			["user", "id"],
			["session", "user_id"],
			["account", "user_id"],
			["member", "user_id"],
			["former_member", "user_id"],
		] as const) {
			expect(await count(table, column, person.id)).toBe(0);
		}

		await vi.waitFor(
			async () => {
				expect(await count("pending_erasure", "user_id", person.id)).toBe(0);
				expect(await transcript(workspaceId, theirs.id)).toBe("[]");
				expect(await registry.conversationIds()).toEqual([ownersOwn.id]);
			},
			{ timeout: 10_000 },
		);
		// The chat they left open is cut off with it.
		await expect(closed).resolves.toEqual(expect.any(Number));
		expect(await transcript(workspaceId, ownersOwn.id)).toContain("The owner's own words");

		const session = await agents.fetch(`${origin}/api/auth/get-session`, {
			headers: { cookie: person.cookie },
		});
		expect(await session.json()).toBeNull();
		const signIn = await authApi("/sign-in/email", {
			client,
			body: { email: person.email, password: PASSWORD },
		});
		expect(signIn.status).toBe(401);
		await vi.waitFor(async () => {
			const told = (await agents.emails()).filter((email) => email.to === person.email);
			expect(told.map((email) => email.subject)).toContain(
				"Your Gateweave Agents account was deleted",
			);
		});
	});

	it("keeps their runs for the workspace's usage, with no words and no name", async () => {
		const client = newClient();
		const owner = await signUp(client, "Rhea", "rhea@delete.test");
		const workspace = await workspaceWithAgent(client, owner.cookie, "usage-stays");
		const person = await signUp(client, "Ruth Runner", "ruth@delete.test");
		await addMember(workspace.workspaceId, person.id);
		const { id, socket } = await talk(workspace, person, "Count this");
		socket.close();
		const [run] = await workspace.registry.listRuns();
		expect(run).toMatchObject({ conversationId: id, startedBy: person.id });

		const response = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(response.status).toBe(200);

		await vi.waitFor(async () => {
			const [after] = await workspace.registry.listRuns();
			expect(after).toMatchObject({ id: run?.id, conversationId: null, startedBy: person.id });
		});
		const page = await agents.fetch(`${origin}/usage-stays/runs`, {
			headers: { cookie: owner.cookie },
		});
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("A former member");
		expect(html).not.toContain("Ruth Runner");
	});

	it("reaches the workspaces they left, which keep their conversations until then", async () => {
		const client = newClient();
		const owner = await signUp(client, "Fay", "fay@delete.test");
		const workspace = await workspaceWithAgent(client, owner.cookie, "left-behind");
		const person = await signUp(client, "Lou Left", "lou@delete.test");
		await addMember(workspace.workspaceId, person.id);
		const { id, socket } = await talk(workspace, person, "Words left behind");
		socket.close();

		const left = await authApi("/organization/leave", {
			client,
			cookie: person.cookie,
			body: { organizationId: workspace.workspaceId },
		});
		expect(left.status).toBe(200);
		expect(await count("former_member", "user_id", person.id)).toBe(1);
		expect(await transcript(workspace.workspaceId, id)).toContain("Words left behind");

		const response = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(response.status).toBe(200);
		expect(await count("former_member", "user_id", person.id)).toBe(0);
		await vi.waitFor(async () => expect(await transcript(workspace.workspaceId, id)).toBe("[]"), {
			timeout: 10_000,
		});
	});

	it("lets someone go who shares the workspace with another owner", async () => {
		const client = newClient();
		const first = await signUp(client, "First", "first@delete.test");
		const workspaceId = await newWorkspace(client, first.cookie, "Two Owners", "two-owners");
		const second = await signUp(client, "Second", "second@delete.test");
		await addMember(workspaceId, second.id, "owner");

		const response = await authApi("/account/delete", {
			client,
			cookie: first.cookie,
			body: { password: PASSWORD },
		});

		expect(response.status).toBe(200);
		expect(await count("member", "organization_id", workspaceId)).toBe(1);
	});

	it("leaves one owner when both try to go at once", async () => {
		const client = newClient();
		const first = await signUp(client, "Ana", "ana@delete.test");
		const workspaceId = await newWorkspace(client, first.cookie, "Both Going", "both-going");
		const second = await signUp(client, "Bo", "bo@delete.test");
		await addMember(workspaceId, second.id, "owner");

		const answers = await Promise.all(
			[first, second].map((person) =>
				authApi("/account/delete", {
					client,
					cookie: person.cookie,
					body: { password: PASSWORD },
				}),
			),
		);

		expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403]);
		const refused = answers.find((answer) => answer.status === 403);
		expect(await refused?.json()).toMatchObject({ code: "ONLY_OWNER_OF_WORKSPACES" });
		expect(await count("member", "organization_id", workspaceId)).toBe(1);
	});

	it("takes the invitations to their address and the ones they sent", async () => {
		const client = newClient();
		const owner = await signUp(client, "Ida", "ida@delete.test");
		const workspaceId = await newWorkspace(client, owner.cookie, "Inviting", "inviting");
		const person = await signUp(client, "Ian", "ian@delete.test");
		await addMember(workspaceId, person.id, "admin");
		const invite = (id: string, email: string, inviter: string) =>
			agents.db
				.prepare(
					"INSERT INTO invitation (id, organization_id, email, status, expires_at, inviter_id) VALUES (?, ?, ?, 'pending', ?, ?)",
				)
				.bind(id, workspaceId, email, Date.now() + 60_000, inviter);
		await agents.db.batch([
			invite("to-them", person.email, owner.id),
			invite("from-them", "someone@delete.test", person.id),
			invite("unrelated", "another@delete.test", owner.id),
		]);

		const response = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(response.status).toBe(200);
		expect(await count("invitation", "id", "to-them")).toBe(0);
		expect(await count("invitation", "id", "from-them")).toBe(0);
		expect(await count("invitation", "id", "unrelated")).toBe(1);
	});

	it("needs no password from an account that has none", async () => {
		const client = newClient();
		const person = await signUp(client, "Nia", "nia@delete.test");
		await agents.db.prepare("DELETE FROM account WHERE user_id = ?").bind(person.id).run();

		const response = await authApi("/account/delete", { client, cookie: person.cookie, body: {} });

		expect(response.status).toBe(200);
		expect(await count("user", "id", person.id)).toBe(0);
	});

	// It asks for a password only where there is one, so a stolen cookie must not be able to remove
	// the password first. That takes another way to sign in, as someone who also uses GitHub has.
	// What else such a cookie can reach is in stolen-cookie.test.ts.
	it("can't be got past by removing the password first", async () => {
		const client = newClient();
		const person = await signUp(client, "Una", "una@delete.test");
		await agents.db
			.prepare(
				"INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES (?, ?, 'github', ?, ?)",
			)
			.bind(crypto.randomUUID(), "12345", person.id, Date.now())
			.run();
		const row = await agents.db
			.prepare("SELECT id FROM account WHERE user_id = ? AND provider_id = 'credential'")
			.bind(person.id)
			.first<{ id: string }>();

		const removing = await authApi("/unlink-account", {
			client,
			cookie: person.cookie,
			body: { accountId: row?.id },
		});
		const deleting = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: {},
		});

		expect({ removing: removing.status, deleting: deleting.status }).toEqual({
			removing: 404,
			deleting: 400,
		});
		expect(await count("user", "id", person.id)).toBe(1);
		expect(await count("account", "user_id", person.id)).toBe(2);
	});

	it("takes nothing else in the body", async () => {
		const client = newClient();
		const person = await signUp(client, "Tess", "tess@delete.test");
		const refused = await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD, userId: "someone-else" },
		});
		expect(refused.status).toBe(400);
		expect(await count("user", "id", person.id)).toBe(1);
	});

	it("starts over for someone who signs up again with the address", async () => {
		const client = newClient();
		const owner = await signUp(client, "Rae", "rae@delete.test");
		const workspaceId = await newWorkspace(client, owner.cookie, "Returning", "returning");
		const person = await signUp(client, "Rob", "rob@delete.test");
		await addMember(workspaceId, person.id);
		await authApi("/account/delete", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		const again = await signUp(client, "Rob", person.email);

		expect(again.id).not.toBe(person.id);
		expect(await count("member", "user_id", again.id)).toBe(0);
	});

	it("keeps Better Auth's own way of doing this closed", async () => {
		const client = newClient();
		const person = await signUp(client, "Dee", "dee@delete.test");
		const response = await authApi("/delete-user", {
			client,
			cookie: person.cookie,
			body: { password: PASSWORD },
		});
		expect(response.status).toBe(404);
		expect(await count("user", "id", person.id)).toBe(1);
	});
});

describe("the account page", () => {
	it("shows who is signed in, and sends anyone else to sign in", async () => {
		const client = newClient();
		const person = await signUp(client, "Penny Page", "penny@delete.test");

		const page = await agents.fetch(`${origin}/settings/account`, {
			headers: { cookie: person.cookie },
		});
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Penny Page");
		expect(html).toContain("Delete account");

		const stranger = await agents.fetch(`${origin}/settings/account`, { redirect: "manual" });
		expect(stranger.status).toBe(307);
		expect(stranger.headers.get("location")).toMatch(/\/login$/);
	});
});

describe("the daily cron", () => {
	it("asks again for what a workspace has not answered, and only that goes", async () => {
		const client = newClient();
		const owner = await signUp(client, "Cleo", "cleo@delete.test");
		const workspace = await workspaceWithAgent(client, owner.cookie, "retried");
		const person = await signUp(client, "Cy", "cy@delete.test");
		await addMember(workspace.workspaceId, person.id);
		const { id, socket } = await talk(workspace, person, "Still here");
		socket.close();
		const note = (userId: string) =>
			agents.db
				.prepare(
					"INSERT INTO pending_erasure (user_id, organization_id, created_at) VALUES (?, ?, ?)",
				)
				.bind(userId, workspace.workspaceId, Date.now());
		// The registry refuses an empty id, as it would fail on any call it could not answer.
		await agents.db.batch([note(person.id), note("")]);
		expect(await transcript(workspace.workspaceId, id)).toContain("Still here");

		await agents.runScheduled();

		expect(await count("pending_erasure", "user_id", person.id)).toBe(0);
		expect(await count("pending_erasure", "user_id", "")).toBe(1);
		await vi.waitFor(async () => expect(await transcript(workspace.workspaceId, id)).toBe("[]"), {
			timeout: 10_000,
		});
		await agents.db.prepare("DELETE FROM pending_erasure WHERE user_id = ''").run();
	});

	it("gets to the rest even when all it asks keep failing", async () => {
		const client = newClient();
		const owner = await signUp(client, "Dot", "dot@delete.test");
		const workspace = await workspaceWithAgent(client, owner.cookie, "queued");
		const person = await signUp(client, "Eli", "eli@delete.test");
		await addMember(workspace.workspaceId, person.id);
		const { id, socket } = await talk(workspace, person, "Still waiting");
		socket.close();
		// As many as one run asks, all older than the one that can go.
		const stuck = Array.from({ length: 20 }, (_, index) => `stuck-${index}`);
		await agents.db.batch(
			stuck.flatMap((workspaceId, index) => [
				agents.db
					.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
					.bind(workspaceId, workspaceId, workspaceId, index + 1),
				agents.db
					.prepare(
						"INSERT INTO pending_erasure (user_id, organization_id, created_at) VALUES ('', ?, ?)",
					)
					.bind(workspaceId, index + 1),
			]),
		);
		await agents.db
			.prepare(
				"INSERT INTO pending_erasure (user_id, organization_id, created_at) VALUES (?, ?, ?)",
			)
			.bind(person.id, workspace.workspaceId, Date.now())
			.run();

		await agents.runScheduled();

		expect(await count("pending_erasure", "user_id", "")).toBe(20);
		expect(await count("pending_erasure", "user_id", person.id)).toBe(1);

		await agents.runScheduled();

		expect(await count("pending_erasure", "user_id", person.id)).toBe(0);
		await vi.waitFor(async () => expect(await transcript(workspace.workspaceId, id)).toBe("[]"), {
			timeout: 10_000,
		});
		await agents.db.batch(
			stuck.map((workspaceId) =>
				agents.db.prepare("DELETE FROM organization WHERE id = ?").bind(workspaceId),
			),
		);
	});
});

describe("a workspace keeps an owner", () => {
	it("counts whoever has owner among their roles, which Better Auth keeps as a list", async () => {
		const client = newClient();
		const owner = await signUp(client, "Iris", "iris@delete.test");
		const workspaceId = await newWorkspace(client, owner.cookie, "Listed", "listed");
		const other = await signUp(client, "Jo", "jo@delete.test");
		await addMember(workspaceId, other.id);
		const setRole = (userId: string, role: string) =>
			agents.db.prepare("UPDATE member SET role = ? WHERE user_id = ?").bind(role, userId).run();
		const remove = (userId: string) =>
			agents.db.prepare("DELETE FROM member WHERE user_id = ?").bind(userId).run();

		// A role that only has the word in it makes nobody an owner.
		await setRole(other.id, "co-owner,admin");
		await expect(remove(owner.id)).rejects.toThrow(/keep an owner/);

		const member = await agents.db
			.prepare("SELECT id FROM member WHERE user_id = ?")
			.bind(other.id)
			.first<{ id: string }>();
		const promoted = await authApi("/organization/update-member-role", {
			client,
			cookie: owner.cookie,
			body: { memberId: member?.id, organizationId: workspaceId, role: ["owner", "admin"] },
		});
		expect(promoted.status).toBe(200);
		const { role } = (await agents.db
			.prepare("SELECT role FROM member WHERE user_id = ?")
			.bind(other.id)
			.first<{ role: string }>()) ?? { role: "" };
		expect(role).toBe("owner,admin");

		// So the plain owner is not the only one, and can go.
		const gone = await authApi("/account/delete", {
			client,
			cookie: owner.cookie,
			body: { password: PASSWORD },
		});
		expect(gone.status).toBe(200);

		// Now they are the last.
		await expect(remove(other.id)).rejects.toThrow(/keep an owner/);
		await expect(setRole(other.id, "admin")).rejects.toThrow(/keep an owner/);
		const refused = await authApi("/account/delete", {
			client,
			cookie: other.cookie,
			body: { password: PASSWORD },
		});
		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe("ONLY_OWNER_OF_WORKSPACES");

		// Staying an owner takes nothing away.
		await setRole(other.id, "admin,owner");
		await setRole(other.id, "owner");
		expect(await count("member", "organization_id", workspaceId)).toBe(1);
	});

	it("holds in the database, however a row comes to change", async () => {
		const client = newClient();
		const owner = await signUp(client, "Hal", "hal@delete.test");
		const workspaceId = await newWorkspace(client, owner.cookie, "Held", "held");

		await expect(
			agents.db.prepare("DELETE FROM member WHERE user_id = ?").bind(owner.id).run(),
		).rejects.toThrow(/keep an owner/);
		await expect(
			agents.db.prepare("UPDATE member SET role = 'member' WHERE user_id = ?").bind(owner.id).run(),
		).rejects.toThrow(/keep an owner/);
		await expect(
			agents.db.prepare("DELETE FROM user WHERE id = ?").bind(owner.id).run(),
		).rejects.toThrow(/keep an owner/);
		expect(await count("member", "organization_id", workspaceId)).toBe(1);
		expect(await count("former_member", "user_id", owner.id)).toBe(0);
	});

	it("does not stand in the way of deleting the workspace, and then the account", async () => {
		const client = newClient();
		const owner = await signUp(client, "Wes", "wes@delete.test");
		const workspace = await workspaceWithAgent(client, owner.cookie, "short-lived");
		const { workspaceId } = workspace;
		const leaver = await signUp(client, "Vi", "vi@delete.test");
		await addMember(workspaceId, leaver.id);
		const { id, socket } = await talk(workspace, owner, "Goes with the workspace");
		socket.close();
		await authApi("/organization/leave", {
			client,
			cookie: leaver.cookie,
			body: { organizationId: workspaceId },
		});
		expect(await count("former_member", "organization_id", workspaceId)).toBe(1);

		const deleted = await authApi("/organization/delete", {
			client,
			cookie: owner.cookie,
			body: { organizationId: workspaceId },
		});

		expect(deleted.status).toBe(200);
		expect(await count("organization", "id", workspaceId)).toBe(0);
		expect(await count("member", "organization_id", workspaceId)).toBe(0);
		expect(await count("former_member", "organization_id", workspaceId)).toBe(0);
		await vi.waitFor(async () => expect(await transcript(workspaceId, id)).toBe("[]"), {
			timeout: 10_000,
		});

		const gone = await authApi("/account/delete", {
			client,
			cookie: owner.cookie,
			body: { password: PASSWORD },
		});
		expect(gone.status).toBe(200);
		expect(await count("pending_erasure", "user_id", owner.id)).toBe(0);
	});
});
