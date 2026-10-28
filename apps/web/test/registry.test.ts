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
	files: [],
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

it("shows each agent's page: where a coding agent is configured, how a Gateweave agent works", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-agents");
	const id = await createWorkspace(agents, origin, ada, "crew");
	const registry = await agents.registry(id);
	const [shop = ""] = await registry.syncRepositories([repository("1", "shop")]);
	await registry.applyScan(shop, CLAUDE_ONLY);
	const coding = (await registry.getRepository(shop))?.agents[0]?.id ?? "";
	const rules = await registry.createLibraryAsset({
		kind: "instructions",
		name: "Reviewer rules",
		text: "Review every change.\n",
	});
	const reviewer = await registry.createAgent({
		name: "Reviewer",
		description: "Reviews pull requests.",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: rules, version: 1 },
	});
	// React separates neighbouring text with comments; the text is what people read.
	const page = async (path: string, cookie = ada.cookie) => {
		const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
		expect(response.status).toBe(200);
		return (await response.text()).replaceAll("<!-- -->", "");
	};

	const list = await page("/crew/agents");
	expect(list).toContain("New agent");
	expect(list).toContain(`/crew/agents/${reviewer.id}`);
	expect(list).toContain(`/crew/agents/${coding}`);

	const defined = await page(`/crew/agents/${reviewer.id}`);
	expect(defined).toContain("Reviews pull requests.");
	expect(defined).toContain('Anthropic · <span class="font-mono">claude-sonnet-5-5</span>');
	expect(defined).toContain("Review every change.");
	expect(defined).toContain(`/crew/assets/${rules}`);
	expect(defined).toContain("The workspace has no Anthropic key, so this agent cannot run yet.");

	const scanned = await page(`/crew/agents/${coding}`);
	expect(scanned).toContain(`/crew/repositories/${shop}`);
	expect(scanned).toContain("Reads · 1");

	// A member who is not an admin sees agents and cannot define them; anyone else gets a 404.
	const { userId: grace, headers: graceHeaders } = await signUp(agents, origin, "grace-agents");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), id, grace, Date.now())
		.run();
	expect(await page("/crew/agents", graceHeaders.cookie)).not.toContain("New agent");
	expect(await page(`/crew/agents/${reviewer.id}`, graceHeaders.cookie)).toContain(
		"An owner or admin can add one in Settings.",
	);
	const { headers: eve } = await signUp(agents, origin, "eve-agents");
	const outsider = await agents.fetch(`${origin}/crew/agents/${reviewer.id}`, {
		headers: { cookie: eve.cookie },
	});
	expect(outsider.status).toBe(404);
	expect(await outsider.text()).not.toContain("Review every change.");
});

/** CLAUDE_ONLY with other text in its CLAUDE.md. */
function claudeSays(text: string): ScanResult {
	const [asset] = CLAUDE_ONLY.assets;
	if (!asset) throw new Error("No asset");
	return { ...CLAUDE_ONLY, assets: [{ ...asset, files: [{ path: "CLAUDE.md", content: text }] }] };
}

it("shows the library, where each version is used, and which repositories are behind", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-library");
	const id = await createWorkspace(agents, origin, ada, "atelier");
	const registry = await agents.registry(id);
	const [old = "", fresh = ""] = await registry.syncRepositories([
		repository("1", "legacy"),
		repository("2", "modern"),
	]);
	await registry.applyScan(old, claudeSays("Be brief.\n"));
	await registry.applyScan(fresh, claudeSays("Be briefer.\n"));
	const assetOf = async (repositoryId: string) =>
		(await registry.getRepository(repositoryId))?.assets[0]?.id ?? "";
	const legacyRules = await assetOf(old);
	const rules = await registry.addToLibrary(legacyRules, { name: "House rules" });
	await registry.addToLibrary(await assetOf(fresh), { libraryAssetId: rules });
	const page = async (path: string) => {
		const response = await agents.fetch(`${origin}${path}`, { headers: { cookie: ada.cookie } });
		expect(response.status).toBe(200);
		return response.text();
	};

	const library = await page("/atelier/library");
	expect(library).toContain("House rules");
	expect(library).toContain(`/atelier/assets/${rules}`);
	expect(library).toContain("on an older version");

	const asset = await page(`/atelier/assets/${rules}`);
	expect(asset).toContain("Be briefer.");
	expect(asset).toContain("legacy");
	expect(asset).toContain("modern");
	expect(asset).toContain("behind");

	// The repository's copy links back to the library, and says it is behind.
	const copy = await page(`/atelier/assets/${legacyRules}`);
	expect(copy).toContain(`/atelier/assets/${rules}`);
	expect(copy).toMatch(/behind v(<!-- -->)?2/);

	const { headers: eve } = await signUp(agents, origin, "eve-library");
	const response = await agents.fetch(`${origin}/atelier/library`, {
		headers: { cookie: eve.cookie },
	});
	expect(response.status).toBe(404);
	expect(await response.text()).not.toContain("House rules");
});

it("shows a written library asset, its edited text and a way to compare its versions", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-written");
	const id = await createWorkspace(agents, origin, ada, "scriptorium");
	const registry = await agents.registry(id);
	// Server functions cannot be called from here (their ids are build-time hashes), so the
	// admin-only checks of writing and editing are covered by the registry's own tests.
	const prompt = await registry.createLibraryAsset({
		kind: "prompt",
		name: "Triage",
		text: "Sort the inbox.\n",
	});
	const page = async (path: string) => {
		const response = await agents.fetch(`${origin}${path}`, { headers: { cookie: ada.cookie } });
		expect(response.status).toBe(200);
		return response.text();
	};

	expect(await page(`/scriptorium/assets/${prompt}`)).not.toContain("Compare versions");

	await registry.editLibraryAsset({
		libraryAssetId: prompt,
		files: [{ path: "triage.md", content: "Sort the inbox by urgency.\n" }],
	});
	const html = await page(`/scriptorium/assets/${prompt}`);
	expect(html).toContain("Sort the inbox by urgency.");
	expect(html).toContain("Compare versions");
	expect(await page("/scriptorium/library")).toContain("Triage");
	// The first version is still there.
	expect(await page(`/scriptorium/assets/${prompt}?version=1`)).toContain("Sort the inbox.");
});

it("shows members each setup, its pins and the files it writes", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-setups");
	const id = await createWorkspace(agents, origin, ada, "foundry");
	const registry = await agents.registry(id);
	const [old = "", fresh = ""] = await registry.syncRepositories([
		repository("1", "legacy"),
		repository("2", "modern"),
	]);
	await registry.applyScan(old, claudeSays("Be brief.\n"));
	await registry.applyScan(fresh, claudeSays("Be briefer.\n"));
	const assetOf = async (repositoryId: string) =>
		(await registry.getRepository(repositoryId))?.assets[0]?.id ?? "";
	const rules = await registry.addToLibrary(await assetOf(old), { name: "CLAUDE.md" });
	const setup = await registry.createSetup({
		name: "Terse agents",
		description: "Short answers everywhere.",
		runtimes: ["claude-code"],
	});
	await registry.setSetupAssets(setup.id, [{ assetId: rules, version: 1 }]);
	// A newer version in the library is an update the setup does not take by itself.
	await registry.addToLibrary(await assetOf(fresh), { libraryAssetId: rules });
	const page = async (path: string) => {
		const response = await agents.fetch(`${origin}${path}`, { headers: { cookie: ada.cookie } });
		expect(response.status).toBe(200);
		return response.text();
	};

	const list = await page("/foundry/setups");
	expect(list).toContain("Terse agents");
	expect(list).toContain(`/foundry/setups/${setup.id}`);
	expect(list).toContain("1 update");

	const detail = await page(`/foundry/setups/${setup.id}`);
	expect(detail).toContain("Short answers everywhere.");
	expect(detail).toContain("Claude Code");
	expect(detail).toContain("CLAUDE.md");
	expect(detail).toMatch(/v(<!-- -->)?2(<!-- -->)? is out/);
	// The preview writes the pinned version, not the newer one.
	expect(detail).toContain("Be brief.");
	expect(detail).not.toContain("Be briefer.");

	const { headers: eve } = await signUp(agents, origin, "eve-setups");
	for (const path of ["/foundry/setups", `/foundry/setups/${setup.id}`]) {
		const response = await agents.fetch(`${origin}${path}`, { headers: { cookie: eve.cookie } });
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("Terse agents");
	}
});

it("lists the ready-made setups on the Setups page, with a button to add each", async () => {
	const { headers: ada } = await signUp(agents, origin, "ada-ready");
	await createWorkspace(agents, origin, ada, "pantry");
	const page = async (cookie: string) => {
		const response = await agents.fetch(`${origin}/pantry/setups`, { headers: { cookie } });
		expect(response.status).toBe(200);
		return response.text();
	};

	const html = await page(ada.cookie);
	expect(html).toContain("Ready-made");
	for (const name of ["Baseline", "Review", "code-review", "github", "security-review"]) {
		expect(html).toContain(name);
	}
	expect(html).toContain("Add to workspace");
	// Nothing was added by looking.
	expect(html).toContain("No setups yet.");
});
