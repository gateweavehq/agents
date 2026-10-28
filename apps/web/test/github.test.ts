import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { FakeGitHub } from "./fake-github";

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
