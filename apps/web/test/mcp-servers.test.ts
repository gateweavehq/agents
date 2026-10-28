// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";

const origin = "https://agents.test";

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
	// React separates adjacent text nodes with comments, and escapes apostrophes.
	return (await response.text()).replaceAll("<!-- -->", "").replaceAll("&#x27;", "'");
}

it("shows an agent's MCP servers, where it reaches them and the variables they still need", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-mcp");
	const workspaceId = await createWorkspace(agents, origin, ada, "relay");
	const registry = await agents.registry(workspaceId);

	const acme = await registry.createMcpServer({
		name: "acme",
		transport: "http",
		url: "https://mcp.acme.dev/mcp",
		headers: [{ name: "Authorization", value: "Bearer ${ACME_TOKEN}" }],
	});
	const prod = await registry.createEnvSet({
		name: "prod",
		variables: {},
		secrets: ["ACME_TOKEN"],
	});
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		environment: { assetId: prod, version: 1 },
		mcpServers: [{ assetId: acme, version: 1 }],
	});

	const agentPage = await page(`/relay/agents/${agent.id}`, ada.cookie);
	for (const text of ["MCP servers · 1", "acme", "https://mcp.acme.dev/mcp", "ACME_TOKEN"]) {
		expect(agentPage).toContain(text);
	}
	expect(agentPage).toContain("has no value in the agent's environment set");

	// Admins add servers in the library and edit their settings on the server's page.
	expect(await page("/relay/library", ada.cookie)).toContain("New MCP server");
	const serverPage = await page(`/relay/assets/${acme}`, ada.cookie);
	expect(serverPage).toContain("Edit settings");
	expect(serverPage).toContain(`href="/relay/agents/${agent.id}">Reviewer</a>`);

	// A member sees the same, without the means to change anything.
	const { userId: grace, headers: graceHeaders } = await signUp(agents, origin, "grace-mcp");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace, Date.now())
		.run();
	expect(await page(`/relay/agents/${agent.id}`, graceHeaders.cookie)).toContain(
		"https://mcp.acme.dev/mcp",
	);
	expect(await page("/relay/library", graceHeaders.cookie)).not.toContain("New MCP server");
	expect(await page(`/relay/assets/${acme}`, graceHeaders.cookie)).not.toContain("Edit settings");

	// Anyone else gets the same answer as for a workspace that does not exist.
	const { headers: eve } = await signUp(agents, origin, "eve-mcp");
	const outsider = await agents.fetch(`${origin}/relay/agents/${agent.id}`, {
		headers: { cookie: eve.cookie },
	});
	expect(outsider.status).toBe(404);
	expect(await outsider.text()).not.toContain("mcp.acme.dev");
});

it("lists the library's MCP servers for members, with the check only admins can run", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-mcp-page");
	const workspaceId = await createWorkspace(agents, origin, ada, "beacon");
	const registry = await agents.registry(workspaceId);

	// With none in the library, the page points to where they are added.
	const empty = await page("/beacon/mcp", ada.cookie);
	expect(empty).toContain("MCP servers");
	expect(empty).toContain("No MCP servers yet");
	expect(empty).toContain("New MCP server");

	const acme = await registry.createMcpServer({
		name: "acme",
		transport: "http",
		url: "https://mcp.acme.dev/mcp",
		headers: [{ name: "Authorization", value: "Bearer ${ACME_TOKEN}" }],
	});
	const prod = await registry.createEnvSet({
		name: "prod",
		variables: {},
		secrets: ["ACME_TOKEN"],
	});
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		environment: { assetId: prod, version: 1 },
		mcpServers: [{ assetId: acme, version: 1 }],
	});
	await registry.recordMcpCheck(acme, {
		ok: true,
		tools: [{ name: "search_issues", description: "Searches the tracker" }],
	});

	const admin = await page("/beacon/mcp", ada.cookie);
	for (const text of [
		"acme",
		"https://mcp.acme.dev/mcp",
		"ACME_TOKEN",
		"Worked",
		"search_issues",
		"Searches the tracker",
		">Check<",
	]) {
		expect(admin).toContain(text);
	}
	expect(admin).toContain(`href="/beacon/assets/${acme}"`);
	expect(admin).toContain(`href="/beacon/agents/${agent.id}">Reviewer</a>`);
	expect(admin).toContain('href="/beacon/mcp"');

	// A member sees the same page, without the means to check.
	const { userId: grace, headers: graceHeaders } = await signUp(agents, origin, "grace-mcp-page");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace, Date.now())
		.run();
	const member = await page("/beacon/mcp", graceHeaders.cookie);
	expect(member).toContain("https://mcp.acme.dev/mcp");
	expect(member).toContain("search_issues");
	expect(member).not.toContain(">Check<");

	// Anyone else gets the same answer as for a workspace that does not exist.
	const { headers: eve } = await signUp(agents, origin, "eve-mcp-page");
	const outsider = await agents.fetch(`${origin}/beacon/mcp`, { headers: { cookie: eve.cookie } });
	expect(outsider.status).toBe(404);
	expect(await outsider.text()).not.toContain("mcp.acme.dev");
});
