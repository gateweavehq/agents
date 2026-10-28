import type { RepositoryInput, ScanResult } from "@gateweave/agents-model";
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

/** A count on the Overview page, as rendered on the server. */
function count(html: string, label: string) {
	return html.match(new RegExp(`${label}</dt><dd[^>]*>(\\d+)<`))?.[1];
}

it("shows members what their workspace's registry holds", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada");
	const id = await createWorkspace(agents, origin, ada, "acme");
	await (await agents.registry(id)).createProject({ name: "Checkout", description: null });

	const page = await agents.fetch(`${origin}/acme`, { headers: { cookie: ada.cookie } });
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(count(html, "Projects")).toBe("1");
	expect(count(html, "Repositories")).toBe("0");
});

it("shows anyone else nothing of it", async () => {
	const { headers: grace } = await signUp(agents, origin, "grace");
	const id = await createWorkspace(agents, origin, grace, "lab");
	await (await agents.registry(id)).createProject({ name: "Hidden", description: null });

	const { headers: eve } = await signUp(agents, origin, "eve");
	const html = await (
		await agents.fetch(`${origin}/lab`, { headers: { cookie: eve.cookie } })
	).text();
	expect(html).toContain("Workspace not found");
	expect(html).not.toContain("Hidden");
	expect(count(html, "Projects")).toBeUndefined();
});

it("deletes the registry with its workspace", async () => {
	const { headers: linus } = await signUp(agents, origin, "linus");
	const id = await createWorkspace(agents, origin, linus, "doomed");
	await (await agents.registry(id)).createProject({ name: "Doomed", description: null });

	const response = await agents.fetch(`${origin}/api/auth/organization/delete`, {
		method: "POST",
		headers: linus,
		body: JSON.stringify({ organizationId: id }),
	});
	expect(response.status).toBe(200);
	expect(await (await agents.registry(id)).overview()).toEqual({
		projects: 0,
		repositories: 0,
		agents: 0,
		assets: 0,
	});
	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
});

function repository(externalId: string, name: string): RepositoryInput {
	return {
		provider: "github",
		externalId,
		installationId: "100",
		owner: "acme",
		name,
		defaultBranch: "main",
		private: false,
	};
}

/** What a scan of a repository with only a CLAUDE.md finds. */
const CLAUDE_ONLY: ScanResult = {
	commit: "c".repeat(40),
	scannedAt: 1_000,
	agents: [
		{
			runtime: "claude-code",
			key: "main",
			name: "Claude Code",
			description: null,
			model: null,
			path: null,
			metadata: {},
			assets: ["CLAUDE.md"],
		},
	],
	assets: [
		{
			kind: "instructions",
			key: "CLAUDE.md",
			name: "CLAUDE.md",
			description: null,
			path: "CLAUDE.md",
			files: [{ path: "CLAUDE.md", content: "Be brief.\n" }],
			metadata: {},
		},
	],
	problems: [],
};

it("shows members each project with its repositories and their agents", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-projects");
	const id = await createWorkspace(agents, origin, ada, "studio");
	const registry = await agents.registry(id);
	const [shop = "", docs = ""] = await registry.syncRepositories([
		repository("1", "shop"),
		repository("2", "docs"),
	]);
	await registry.applyScan(shop, CLAUDE_ONLY);
	const project = await registry.createProject({ name: "Storefront", description: "Selling." });
	await registry.setProjectRepositories(project.id, [shop, docs]);

	const list = await agents.fetch(`${origin}/studio/projects`, { headers: { cookie: ada.cookie } });
	expect(list.status).toBe(200);
	const listHtml = await list.text();
	expect(listHtml).toContain("Storefront");
	expect(listHtml).toContain(`/studio/projects/${project.id}`);

	const page = await agents.fetch(`${origin}/studio/projects/${project.id}`, {
		headers: { cookie: ada.cookie },
	});
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(html).toContain("Selling.");
	expect(html).toContain('aria-label="Uses Claude Code"');
	expect(html).toContain(`/studio/repositories/${shop}`);
	expect(html).toContain(`/studio/repositories/${docs}`);

	const { headers: eve } = await signUp(agents, origin, "eve-projects");
	for (const path of ["/studio/projects", `/studio/projects/${project.id}`]) {
		const response = await agents.fetch(`${origin}${path}`, { headers: { cookie: eve.cookie } });
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("Storefront");
	}
});
