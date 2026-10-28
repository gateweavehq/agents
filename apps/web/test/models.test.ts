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

it("turns model keys off on a server without a SECRETS_KEY", async () => {
	const bare = await startAgents(origin, { secrets: false });
	try {
		const { headers: ada } = await signUp(bare, origin, "ada-bare");
		const workspaceId = await createWorkspace(bare, origin, ada, "bare");
		const registry = await bare.registry(workspaceId);
		expect(await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada")).toEqual({
			status: "refused",
			message: "Secrets are not set up on this server (SECRETS_KEY)",
		});
		const response = await bare.fetch(`${origin}/bare/settings/models`, {
			headers: { cookie: ada.cookie },
		});
		expect(await response.text()).toContain("Model keys are not set up on this server");
	} finally {
		await bare.dispose();
	}
});
