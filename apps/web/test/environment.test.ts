import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";

const origin = "https://agents.test";
const PASSWORD = "hunter2-correct-horse-battery";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments.
	return (await response.text()).replaceAll("<!-- -->", "");
}

it("shows secret names as Set or Missing to admins and members, and never a value", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-env");
	const workspaceId = await createWorkspace(agents, origin, ada, "forge");
	const registry = await agents.registry(workspaceId);

	expect(await page("/forge/environment", ada.cookie)).toContain("No environment sets yet");

	const assetId = await registry.createEnvSet({
		name: "production",
		variables: { REGION: "eu-west" },
		secrets: ["DATABASE_PASSWORD", "API_TOKEN"],
	});
	await registry.setEnvSecret({ assetId, name: "DATABASE_PASSWORD", value: PASSWORD }, "Ada");
	await registry.createAgent({
		name: "Deployer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		environment: { assetId, version: 1 },
	});

	const html = await page("/forge/environment", ada.cookie);
	for (const text of ["production", "REGION", "eu-west", "DATABASE_PASSWORD", "API_TOKEN"]) {
		expect(html).toContain(text);
	}
	expect(html).toContain("Set by Ada");
	expect(html).toContain("Missing");
	expect(html).toContain("Deployer");
	// An admin can set and replace values.
	expect(html).toContain("Replace");
	expect(html).toContain("New set");
	expect(html).not.toContain("hunter2");
	expect(html).not.toContain(PASSWORD);

	// A member sees the same, without the means to change anything.
	const { userId: grace, headers: graceHeaders } = await signUp(agents, origin, "grace-env");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace, Date.now())
		.run();
	const theirs = await page("/forge/environment", graceHeaders.cookie);
	for (const text of ["production", "REGION", "DATABASE_PASSWORD", "API_TOKEN", "Missing", "Set"]) {
		expect(theirs).toContain(text);
	}
	expect(theirs).not.toContain("hunter2");
	expect(theirs).not.toContain("New set");
	expect(theirs).not.toContain("Replace");

	// The agent's own page names its set, and the library's lists it as an asset.
	const [deployer] = await registry.listEnvSets().then((sets) => sets[0]?.agents ?? []);
	const agentPage = await page(`/forge/agents/${deployer?.id}`, graceHeaders.cookie);
	expect(agentPage).toContain("production");
	expect(agentPage).not.toContain("hunter2");

	// Anyone else gets the same answer as for a workspace that does not exist.
	const { headers: eve } = await signUp(agents, origin, "eve-env");
	const outsider = await agents.fetch(`${origin}/forge/environment`, {
		headers: { cookie: eve.cookie },
	});
	expect(outsider.status).toBe(404);
	const body = await outsider.text();
	expect(body).not.toContain("DATABASE_PASSWORD");
	expect(body).not.toContain("production");
});

it("turns secret values off on a server without a SECRETS_KEY, and says so", async () => {
	const bare = await startAgents(origin, { secrets: false });
	try {
		const { headers: ada } = await signUp(bare, origin, "ada-bare-env");
		const workspaceId = await createWorkspace(bare, origin, ada, "bare-env");
		const registry = await bare.registry(workspaceId);
		// A set with only variables works without secrets.
		const assetId = await registry.createEnvSet({
			name: "plain",
			variables: { REGION: "eu" },
			secrets: ["TOKEN"],
		});
		expect(await registry.setEnvSecret({ assetId, name: "TOKEN", value: "t" }, "Ada")).toEqual({
			status: "refused",
			message: "Secrets are not set up on this server (SECRETS_KEY)",
		});

		const response = await bare.fetch(`${origin}/bare-env/environment`, {
			headers: { cookie: ada.cookie },
		});
		expect(response.status).toBe(200);
		const html = (await response.text()).replaceAll("<!-- -->", "");
		expect(html).toContain("Secret values cannot be stored");
		expect(html).toContain("REGION");
		expect(html).toContain("Missing");
		expect(html).not.toContain(">Set<");
	} finally {
		await bare.dispose();
	}
});
