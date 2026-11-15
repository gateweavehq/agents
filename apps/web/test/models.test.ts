import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { FakeModels } from "./fake-models";

const origin = "https://agents.test";
const KEY = "sk-proj-correct-horse-battery-staple";

const models = new FakeModels({
	[KEY]: { provider: "openai", models: ["gpt-a", "gpt-b", "gpt-c"] },
});

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { models });
});

afterAll(async () => {
	await agents?.dispose();
});

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	return response.text();
}

it("keeps a workspace's model keys sealed, and shows members only their last characters", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-models");
	const workspaceId = await createWorkspace(agents, origin, ada, "studio");
	const registry = await agents.registry(workspaceId);

	expect(await page("/studio/settings/models", ada.cookie)).toContain("No key");
	const saved = await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
	expect(saved).toMatchObject({ provider: "openai", hint: "aple", addedBy: "Ada" });

	// The key reaches the provider, in its header, and nowhere else.
	expect(await registry.checkProviderKey("openai")).toMatchObject({
		check: { ok: true, models: 3 },
	});
	expect(models.requests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${KEY}`);

	const html = await page("/studio/settings/models", ada.cookie);
	expect(html).toContain("••••aple");
	expect(html).toContain("3 models");
	expect(html).toContain("Replace");
	expect(html).not.toContain("correct-horse");

	// A member who is not an admin sees which providers have keys, and cannot change them.
	const { userId: grace, headers: graceHeaders } = await signUp(agents, origin, "grace-models");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace, Date.now())
		.run();
	const theirs = await page("/studio/settings/models", graceHeaders.cookie);
	expect(theirs).toContain("••••aple");
	expect(theirs).not.toContain("Replace");
	expect(theirs).toContain("An owner or admin can add or change keys.");

	// Anyone else gets the same answer as for a workspace that does not exist.
	const { headers: eve } = await signUp(agents, origin, "eve-models");
	const outsider = await agents.fetch(`${origin}/studio/settings/models`, {
		headers: { cookie: eve.cookie },
	});
	expect(outsider.status).toBe(404);
	expect(await outsider.text()).not.toContain("••••aple");
});

it("says when a key stops working, in its own words", async () => {
	const { headers: linus } = await signUp(agents, origin, "linus-models");
	const workspaceId = await createWorkspace(agents, origin, linus, "foundry");
	const registry = await agents.registry(workspaceId);
	await registry.saveProviderKey({ provider: "openai", key: "sk-proj-revoked-long-ago" }, "Linus");

	expect(await registry.checkProviderKey("openai")).toMatchObject({
		check: { ok: false, message: "OpenAI refused the key", models: null },
	});
	const html = await page("/foundry/settings/models", linus.cookie);
	expect(html).toContain("OpenAI refused the key");
	expect(html).not.toContain("revoked-long-ago");
});

it("keeps model keys on a server without a SECRETS_KEY, as a first deploy is", async () => {
	// What the Deploy button leaves: BETTER_AUTH_SECRET and nothing else.
	const bare = await startAgents(origin, { secrets: false, models });
	try {
		const { headers: ada } = await signUp(bare, origin, "ada-bare");
		const workspaceId = await createWorkspace(bare, origin, ada, "bare");
		const registry = await bare.registry(workspaceId);
		expect(await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada")).toMatchObject({
			provider: "openai",
			hint: "aple",
		});
		// It opens again, and reaches the provider.
		expect(await registry.checkProviderKey("openai")).toMatchObject({
			check: { ok: true, models: 3 },
		});
		expect(models.requests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		const response = await bare.fetch(`${origin}/bare/settings/models`, {
			headers: { cookie: ada.cookie },
		});
		const html = await response.text();
		expect(html).toContain("••••aple");
		expect(html).not.toContain("Model keys are not set up on this server");
		expect(html).not.toContain("correct-horse");
	} finally {
		await bare.dispose();
	}
});

it("turns model keys off on a server whose SECRETS_KEY is unusable, and says so", async () => {
	// The key that is set decides: a server never seals under another one behind its operator's back.
	const broken = await startAgents(origin, {
		secrets: false,
		settings: { SECRETS_KEY: btoa("too short") },
	});
	try {
		const { headers: ada } = await signUp(broken, origin, "ada-broken");
		const workspaceId = await createWorkspace(broken, origin, ada, "broken");
		const registry = await broken.registry(workspaceId);
		expect(await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada")).toEqual({
			status: "refused",
			message: "SECRETS_KEY must hold at least 32 bytes",
		});
		const response = await broken.fetch(`${origin}/broken/settings/models`, {
			headers: { cookie: ada.cookie },
		});
		expect(await response.text()).toContain("Model keys are not set up on this server");
	} finally {
		await broken.dispose();
	}
});

it("says that the SECRETS_KEY is gone, and keeps nothing new, when a server loses it", async () => {
	const lost =
		"Values here were sealed with a SECRETS_KEY that this server no longer has; put it back";
	const server = await startAgents(origin, { models });
	try {
		const { headers: ada } = await signUp(server, origin, "ada-lost");
		const workspaceId = await createWorkspace(server, origin, ada, "lost");
		const empty = await createWorkspace(server, origin, ada, "lost-empty");
		let registry = await server.registry(workspaceId);
		await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
		const assetId = await registry.createEnvSet({
			name: "prod",
			variables: {},
			secrets: ["TOKEN"],
		});
		const html = async (path: string) =>
			(await (await server.fetch(`${origin}${path}`, { headers: { cookie: ada.cookie } })).text())
				// React separates adjacent text nodes with comments.
				.replaceAll("<!-- -->", "");

		// The next deploy comes without the key.
		await server.restartWith({ SECRETS_KEY: null });
		registry = await server.registry(workspaceId);
		const refused = { status: "refused", message: lost };
		expect(await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada")).toEqual(
			refused,
		);
		expect(await registry.setEnvSecret({ assetId, name: "TOKEN", value: "t" }, "Ada")).toEqual(
			refused,
		);
		const asked = models.requests.length;
		expect(await registry.checkProviderKey("openai")).toEqual(refused);
		expect(models.requests.length).toBe(asked);
		expect(await registry.sealedCounts()).toEqual({ explicit: 1, derived: 0 });

		// The pages name the cause, and the key that is stored stays listed.
		const page = await html("/lost/settings/models");
		expect(page).toContain(lost);
		expect(page).toContain("••••aple");
		expect(page).not.toContain("add it again");
		expect(await html("/lost/environment")).toContain(lost);
		// A workspace that stored nothing with the key is not held back by it.
		expect(await html("/lost-empty/settings/models")).not.toContain(lost);
		expect(
			await (await server.registry(empty)).saveProviderKey({ provider: "openai", key: KEY }, "Ada"),
		).toMatchObject({ hint: "aple" });

		// Putting the key back is all it takes.
		await server.restartWith({});
		registry = await server.registry(workspaceId);
		expect(await registry.checkProviderKey("openai")).toMatchObject({
			check: { ok: true, models: 3 },
		});
		expect(await html("/lost/settings/models")).not.toContain(lost);
	} finally {
		await server.dispose();
	}
});

it("keeps no secrets on a server that turned the derived key off, as before there was one", async () => {
	const off = await startAgents(origin, {
		secrets: false,
		settings: { SECRETS_FROM_AUTH_SECRET: "off" },
	});
	try {
		const { headers: ada } = await signUp(off, origin, "ada-off");
		const workspaceId = await createWorkspace(off, origin, ada, "off");
		const registry = await off.registry(workspaceId);
		expect(await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada")).toEqual({
			status: "refused",
			message: "Secrets are not set up on this server (SECRETS_KEY)",
		});
		expect(await registry.sealedCounts()).toEqual({ explicit: 0, derived: 0 });
		const response = await off.fetch(`${origin}/off/settings/models`, {
			headers: { cookie: ada.cookie },
		});
		expect(await response.text()).toContain("Model keys are not set up on this server");
	} finally {
		await off.dispose();
	}
});

it("keeps no secrets under a BETTER_AUTH_SECRET someone typed, and says how to fix it", async () => {
	const typed = await startAgents(origin, {
		secrets: false,
		settings: { BETTER_AUTH_SECRET: "password".repeat(4) },
	});
	try {
		const { headers: ada } = await signUp(typed, origin, "ada-typed");
		const workspaceId = await createWorkspace(typed, origin, ada, "typed");
		const registry = await typed.registry(workspaceId);
		const refusal = await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
		expect(refusal).toMatchObject({
			status: "refused",
			message: expect.stringContaining("BETTER_AUTH_SECRET is too short or too simple"),
		});
		const response = await typed.fetch(`${origin}/typed/settings/models`, {
			headers: { cookie: ada.cookie },
		});
		const html = await response.text();
		expect(html).toContain("Model keys are not set up on this server");
		expect(html).toContain(
			"Set one that was generated (openssl rand -base64 32), or set a SECRETS_KEY",
		);
		expect(html).not.toContain("passwordpassword");
	} finally {
		await typed.dispose();
	}
});
