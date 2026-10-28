import type { Repository } from "@gateweave/agents-model";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { FakeGitHub, type FakeRepository, gitBlobId, headOf } from "./fake-github";

const origin = "https://agents.test";
const github = new FakeGitHub();

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { github });
});

afterAll(async () => {
	await agents?.dispose();
});

/** The cookies a response sets, as a request would send them back. */
function cookies(response: Response) {
	return response.headers
		.getSetCookie()
		.map((header) => header.split(";")[0])
		.join("; ");
}

function location(response: Response) {
	expect(response.status).toBe(302);
	return response.headers.get("location") ?? "";
}

/**
 * Walks the connect flow as a browser would: install on GitHub, come back to the setup URL with
 * `installationId`, approve the app as `login`, and land on the callback. Returns where the
 * callback sends them.
 */
async function connect(cookie: string, slug: string, installationId: string, login: string) {
	const install = new URL(
		location(
			await agents.fetch(`${origin}/api/github/install?workspace=${slug}`, { headers: { cookie } }),
		),
	);
	expect(install.origin + install.pathname).toBe(
		`https://github.com/apps/${github.slug}/installations/new`,
	);

	const setup = new URL(`${origin}/api/github/setup`);
	setup.searchParams.set("installation_id", installationId);
	setup.searchParams.set("setup_action", "install");
	setup.searchParams.set("state", install.searchParams.get("state") ?? "");
	const setupResponse = await agents.fetch(setup, { headers: { cookie } });
	const callback = github.authorize(location(setupResponse), login);

	return location(
		await agents.fetch(callback, {
			headers: { cookie: `${cookie}; ${cookies(setupResponse)}` },
		}),
	);
}

async function linkedInstallations(workspaceId: string) {
	const { results } = await agents.db
		.prepare("SELECT id, account_login FROM github_installation WHERE workspace_id = ?")
		.bind(workspaceId)
		.all();
	return results;
}

async function repositoryNames(workspaceId: string) {
	const repositories = await (await agents.registry(workspaceId)).listRepositories();
	return repositories.map((repository) => `${repository.owner}/${repository.name}`).sort();
}

async function deliver(event: string, payload: unknown, signature?: string) {
	const body = JSON.stringify(payload);
	return agents.fetch(`${origin}/api/github/webhooks`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-hub-signature-256": signature ?? github.sign(body),
		},
		body,
	});
}

describe("connecting GitHub", () => {
	it("links an installation its admin can reach, and lists its repositories", async () => {
		github.installations.set("501", {
			account: { login: "acme-org", type: "Organization" },
			repositories: [
				{ id: 11, name: "site", owner: "acme-org" },
				{ id: 12, name: "api", owner: "acme-org", defaultBranch: "trunk" },
			],
		});
		github.people.set("ada-gh", new Set(["501"]));
		const { headers } = await signUp(agents, origin, "ada");
		const workspaceId = await createWorkspace(agents, origin, headers, "acme");

		expect(await connect(headers.cookie, "acme", "501", "ada-gh")).toBe(
			"/acme/settings/github?github=connected",
		);
		expect(await linkedInstallations(workspaceId)).toEqual([
			{ id: "501", account_login: "acme-org" },
		]);
		const repositories = await (await agents.registry(workspaceId)).listRepositories();
		expect(
			repositories.map(({ name, defaultBranch, installationId }) => ({
				name,
				defaultBranch,
				installationId,
			})),
		).toEqual(
			expect.arrayContaining([
				{ name: "site", defaultBranch: "main", installationId: "501" },
				{ name: "api", defaultBranch: "trunk", installationId: "501" },
			]),
		);

		const page = await agents.fetch(`${origin}/acme/settings/github`, {
			headers: { cookie: headers.cookie },
		});
		expect(await page.text()).toContain("acme-org");
	});

	it("refuses an installation id the person cannot reach on GitHub", async () => {
		// Anyone can call the setup URL with any installation's id.
		github.installations.set("502", {
			account: { login: "victim", type: "User" },
			repositories: [{ id: 21, name: "secrets", owner: "victim" }],
		});
		github.people.set("mallory-gh", new Set());
		const { headers } = await signUp(agents, origin, "mallory");
		const workspaceId = await createWorkspace(agents, origin, headers, "heist");

		expect(await connect(headers.cookie, "heist", "502", "mallory-gh")).toBe(
			"/heist/settings/github?github=denied",
		);
		expect(await linkedInstallations(workspaceId)).toEqual([]);
		expect(await repositoryNames(workspaceId)).toEqual([]);
	});

	it("keeps an installation in the workspace that linked it first", async () => {
		github.installations.set("503", {
			account: { login: "shared", type: "Organization" },
			repositories: [{ id: 31, name: "tools", owner: "shared" }],
		});
		github.people.set("grace-gh", new Set(["503"]));
		const { headers } = await signUp(agents, origin, "grace");
		const first = await createWorkspace(agents, origin, headers, "first");
		const second = await createWorkspace(agents, origin, headers, "second");

		expect(await connect(headers.cookie, "first", "503", "grace-gh")).toContain("github=connected");
		expect(await connect(headers.cookie, "second", "503", "grace-gh")).toBe(
			"/second/settings/github?github=taken",
		);
		expect(await repositoryNames(first)).toEqual(["shared/tools"]);
		expect(await repositoryNames(second)).toEqual([]);
	});

	it("lets only admins start it", async () => {
		const owner = await signUp(agents, origin, "olga");
		const workspaceId = await createWorkspace(agents, origin, owner.headers, "guarded");
		const member = await signUp(agents, origin, "mike");
		await agents.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
			)
			.bind(crypto.randomUUID(), workspaceId, member.userId, Date.now())
			.run();

		const response = await agents.fetch(`${origin}/api/github/install?workspace=guarded`, {
			headers: { cookie: member.headers.cookie },
		});
		expect(location(response)).toBe("/guarded/settings/github?github=forbidden");

		const outsider = await signUp(agents, origin, "otto");
		const hidden = await agents.fetch(`${origin}/api/github/install?workspace=guarded`, {
			headers: { cookie: outsider.headers.cookie },
		});
		expect(hidden.status).toBe(404);
	});
});

describe("GitHub webhooks", () => {
	it("refuses deliveries without the app's signature", async () => {
		const response = await deliver("installation", { action: "deleted" }, "sha256=00");
		expect(response.status).toBe(401);
	});

	it("acknowledges deliveries for installations no workspace linked", async () => {
		const response = await deliver("installation", {
			action: "created",
			installation: { id: 999 },
		});
		expect(response.status).toBe(202);
	});

	it("follows the repositories an installation reaches, until it is uninstalled", async () => {
		github.installations.set("504", {
			account: { login: "hopper", type: "User" },
			repositories: [
				{ id: 41, name: "cobol", owner: "hopper" },
				{ id: 42, name: "flowmatic", owner: "hopper" },
			],
		});
		github.people.set("hopper-gh", new Set(["504"]));
		const { headers } = await signUp(agents, origin, "hopper");
		const workspaceId = await createWorkspace(agents, origin, headers, "navy");
		expect(await connect(headers.cookie, "navy", "504", "hopper-gh")).toContain("github=connected");

		const installation = github.installations.get("504");
		if (!installation) throw new Error("The installation is gone");
		installation.repositories = [
			{ id: 41, name: "cobol", owner: "hopper" },
			{ id: 43, name: "a0", owner: "hopper" },
		];
		const changed = await deliver("installation_repositories", {
			action: "added",
			installation: { id: 504 },
		});
		expect(changed.status).toBe(204);
		expect(await repositoryNames(workspaceId)).toEqual(["hopper/a0", "hopper/cobol"]);

		const removed = await deliver("installation", { action: "deleted", installation: { id: 504 } });
		expect(removed.status).toBe(204);
		expect(await linkedInstallations(workspaceId)).toEqual([]);
		expect(await repositoryNames(workspaceId)).toEqual([]);
		expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
	});
});

describe("scanning", () => {
	/** Waits until the workspace's only repository has been scanned at `commit`. */
	async function scannedAt(workspaceId: string, commit: string) {
		const registry = await agents.registry(workspaceId);
		let found: Repository | undefined;
		await vi.waitFor(
			async () => {
				[found] = await registry.listRepositories();
				expect(found?.scannedCommit).toBe(commit);
			},
			{ timeout: 10_000, interval: 50 },
		);
		if (!found) throw new Error("No repository");
		return (await registry.getRepository(found.id)) ?? undefined;
	}

	async function connected(installationId: string, repository: FakeRepository) {
		github.installations.set(installationId, {
			account: { login: repository.owner, type: "User" },
			repositories: [repository],
		});
		github.people.set(`${repository.owner}-gh`, new Set([installationId]));
		const { headers } = await signUp(agents, origin, repository.owner);
		const workspaceId = await createWorkspace(agents, origin, headers, repository.owner);
		expect(
			await connect(headers.cookie, repository.owner, installationId, `${repository.owner}-gh`),
		).toContain("github=connected");
		return { workspaceId, cookie: headers.cookie };
	}

	function push(installationId: string, repository: FakeRepository, branch = "main") {
		return deliver("push", {
			ref: `refs/heads/${branch}`,
			after: headOf(repository),
			repository: { id: repository.id, default_branch: repository.defaultBranch ?? "main" },
			installation: { id: Number(installationId) },
		});
	}

	it("finds the agents of a connected repository, and reads again what a push changes", async () => {
		const skill = "---\nname: review\ndescription: Reviews a change.\n---\nReview it.\n";
		const repository: FakeRepository = {
			id: 61,
			owner: "lovelace",
			name: "engine",
			files: {
				"CLAUDE.md": "Be brief.\n",
				".claude/skills/review/SKILL.md": skill,
				"src/index.ts": "export {};\n",
			},
		};
		const { workspaceId } = await connected("601", repository);

		const first = await scannedAt(workspaceId, headOf(repository));
		expect(first?.agents.map((agent) => `${agent.runtime}:${agent.key}`)).toEqual([
			"claude-code:main",
		]);
		expect(first?.assets.map((asset) => asset.key).sort()).toEqual([
			".claude/skills/review",
			"CLAUDE.md",
		]);
		// Only the files an adapter reads are downloaded.
		expect(github.blobRequests).not.toContain(gitBlobId("export {};\n"));

		const asked = github.blobRequests.length;
		repository.files = { ...repository.files, "CLAUDE.md": "Be briefer.\n" };
		expect((await push("601", repository)).status).toBe(204);
		const second = await scannedAt(workspaceId, headOf(repository));
		const claudeMd = second?.assets.find((asset) => asset.key === "CLAUDE.md");
		expect(claudeMd?.version).toBe(2);
		// The skill is unchanged and the registry has its text, so only CLAUDE.md is downloaded.
		expect(github.blobRequests.slice(asked)).toEqual([gitBlobId("Be briefer.\n")]);

		// Pushes to other branches are not scanned.
		expect((await push("601", repository, "feature")).status).toBe(202);
	});

	it("reads a CLAUDE.md that is a symlink as the file it points to", async () => {
		const repository: FakeRepository = {
			id: 62,
			owner: "hamilton",
			name: "apollo",
			files: { "AGENTS.md": "Shared rules.\n", "CLAUDE.md": { symlink: "AGENTS.md" } },
		};
		const { workspaceId } = await connected("602", repository);

		const detail = await scannedAt(workspaceId, headOf(repository));
		const claudeMd = detail?.assets.find((asset) => asset.key === "CLAUDE.md");
		const version = await (await agents.registry(workspaceId)).getAssetVersion(claudeMd?.id ?? "");
		expect(version?.files).toEqual([
			{
				path: "CLAUDE.md",
				blob: gitBlobId("Shared rules.\n"),
				size: 14,
				content: "Shared rules.\n",
			},
		]);
		expect(detail?.repository.problems).toEqual([]);
	});

	it("records why a scan failed, and keeps what the last one found", async () => {
		const repository: FakeRepository = {
			id: 63,
			owner: "liskov",
			name: "clu",
			files: { "AGENTS.md": "Rules.\n" },
		};
		const { workspaceId } = await connected("603", repository);
		const commit = headOf(repository);
		await scannedAt(workspaceId, commit);

		github.failing.set("liskov/clu", 502);
		repository.files = { "AGENTS.md": "New rules.\n" };
		expect((await push("603", repository)).status).toBe(204);
		const registry = await agents.registry(workspaceId);
		await vi.waitFor(
			async () => {
				const [found] = await registry.listRepositories();
				expect(found?.scanError).toContain("GitHub answered 502");
				expect(found?.scannedCommit).toBe(commit);
			},
			{ timeout: 10_000, interval: 50 },
		);
		expect((await registry.overview()).assets).toBe(1);
	});

	it("reads an unchanged branch again only when asked to", async () => {
		const repository: FakeRepository = {
			id: 64,
			owner: "dijkstra",
			name: "semaphores",
			files: { "AGENTS.md": "Rules.\n" },
		};
		const { workspaceId } = await connected("604", repository);
		const first = await scannedAt(workspaceId, headOf(repository));
		const id = first?.repository.id ?? "";
		const registry = await agents.registry(workspaceId);

		// A push or a reconnect at the same commit has nothing new to read.
		expect(await registry.requestScans([id])).toBe(1);
		await vi.waitFor(
			async () => expect((await registry.getRepository(id))?.repository.scanPending).toBe(false),
			{ timeout: 10_000, interval: 50 },
		);
		expect((await registry.getRepository(id))?.repository.scannedAt).toBe(
			first?.repository.scannedAt,
		);

		// "Scan now" reads it anyway, for after the adapters learn something new.
		expect(await registry.requestScans([id], true)).toBe(1);
		await vi.waitFor(
			async () => {
				const again = (await registry.getRepository(id))?.repository;
				expect(again?.scanPending).toBe(false);
				expect(again?.scannedAt).toBeGreaterThan(first?.repository.scannedAt ?? 0);
			},
			{ timeout: 10_000, interval: 50 },
		);
	});
});

describe("registry pages", () => {
	async function page(path: string, cookie: string) {
		const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
		expect(response.status).toBe(200);
		return response.text();
	}

	it("show members each repository, its agents and the text of what they read", async () => {
		const repository: FakeRepository = {
			id: 71,
			owner: "backus",
			name: "compiler",
			files: {
				"CLAUDE.md": "Prefer small diffs.\n",
				".claude/skills/review/SKILL.md":
					"---\nname: review\ndescription: Reviews a change.\n---\nReview it.\n",
			},
		};
		github.installations.set("701", {
			account: { login: "backus", type: "User" },
			repositories: [repository],
		});
		github.people.set("backus-gh", new Set(["701"]));
		const { headers } = await signUp(agents, origin, "backus");
		const workspaceId = await createWorkspace(agents, origin, headers, "backus");
		await connect(headers.cookie, "backus", "701", "backus-gh");
		const registry = await agents.registry(workspaceId);
		const detail = await vi.waitFor(
			async () => {
				const [found] = await registry.listRepositories();
				const scanned = found ? await registry.getRepository(found.id) : null;
				expect(scanned?.repository.scannedCommit).toBe(headOf(repository));
				return scanned;
			},
			{ timeout: 10_000, interval: 50 },
		);
		if (!detail) throw new Error("Not scanned");
		const { repository: scanned, assets } = detail;
		const claudeMd = assets.find((asset) => asset.key === "CLAUDE.md");
		if (!claudeMd) throw new Error("No CLAUDE.md");
		const cookie = headers.cookie;

		expect(await page("/backus", cookie)).toContain('aria-label="Uses Claude Code"');
		expect(await page("/backus/repositories", cookie)).toContain("compiler");
		const repositoryPage = await page(`/backus/repositories/${scanned.id}`, cookie);
		expect(repositoryPage).toContain("Reviews a change.");
		expect(repositoryPage).toContain(`/backus/assets/${claudeMd.id}`);
		expect(await page("/backus/agents", cookie)).toContain(`/backus/repositories/${scanned.id}`);
		expect(await page(`/backus/assets/${claudeMd.id}`, cookie)).toContain("Prefer small diffs.");

		// Earlier versions stay readable after a push changes the file.
		repository.files = { ...repository.files, "CLAUDE.md": "Prefer smaller diffs.\n" };
		await deliver("push", {
			ref: "refs/heads/main",
			after: headOf(repository),
			repository: { id: repository.id, default_branch: "main" },
			installation: { id: 701 },
		});
		await vi.waitFor(
			async () =>
				expect((await registry.getRepository(scanned.id))?.repository.scannedCommit).toBe(
					headOf(repository),
				),
			{ timeout: 10_000, interval: 50 },
		);
		expect(await page(`/backus/assets/${claudeMd.id}`, cookie)).toContain("Prefer smaller diffs.");
		const first = await page(`/backus/assets/${claudeMd.id}?version=1`, cookie);
		expect(first).toContain("Prefer small diffs.");
		expect(first).not.toContain("Prefer smaller diffs.");

		// Someone outside the workspace gets the answer a missing workspace gets.
		const { headers: eve } = await signUp(agents, origin, "eve-pages");
		for (const path of [
			`/backus/repositories/${scanned.id}`,
			`/backus/assets/${claudeMd.id}`,
			"/backus/agents",
		]) {
			const response = await agents.fetch(`${origin}${path}`, { headers: { cookie: eve.cookie } });
			expect(response.status).toBe(404);
			const html = await response.text();
			expect(html).toContain("Workspace not found");
			expect(html).not.toContain("compiler");
			expect(html).not.toContain("Prefer small");
		}
	});
});
