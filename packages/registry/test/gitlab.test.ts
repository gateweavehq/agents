import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

const TOKEN = "glpat-abcdefghijklmnop1234";
const BASE = "https://gitlab.example.test";
const COMMIT = "c".repeat(40);

/** Git's id for a file with this text, as GitLab's tree gives it. */
const blobOf = (text: string) => {
	const bytes = new TextEncoder().encode(text);
	return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

const CLAUDE_MD = "# Shop\n\nRun the tests before you push.\n";
const SKILL_MD = "---\nname: review\ndescription: Reviews a change\n---\n\nRead the diff.\n";

/**
 * A stand-in for GitLab's API: a token, the projects it reaches, and one repository whose tree
 * comes in two keyset pages.
 */
function fakeGitLab(options: { projects?: unknown[]; token?: string } = {}) {
	const files: Record<string, string> = {
		"CLAUDE.md": CLAUDE_MD,
		".claude/skills/review/SKILL.md": SKILL_MD,
		"src/index.ts": "export {};\n",
	};
	const blobs = new Map(Object.values(files).map((text) => [blobOf(text), text]));
	const entries = Object.entries(files).map(([path, text]) => ({
		id: blobOf(text),
		type: "blob",
		path,
		mode: "100644",
	}));
	const projects = options.projects ?? [
		project(7, "shop", "acme/web"),
		project(8, "empty", "acme", { default_branch: null }),
		project(9, "old", "acme", { archived: true }),
	];
	const requests: { url: string; token: string | null; redirect: string | undefined }[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const token = new Headers(init?.headers).get("PRIVATE-TOKEN");
		requests.push({ url: url.href, token, redirect: init?.redirect });
		if (url.origin !== BASE) return new Response("Not here", { status: 599 });
		if (token !== (options.token ?? TOKEN)) return new Response("", { status: 401 });
		const path = url.pathname.replace("/api/v4", "");
		if (path === "/user") return Response.json({ username: "project_7_bot", name: "Bot" });
		if (path === "/projects") return Response.json(projects, { headers: { "x-next-page": "" } });
		if (path === "/projects/7/repository/branches/main") {
			return Response.json({ commit: { id: COMMIT } });
		}
		if (path === "/projects/7/repository/tree") {
			expect(url.searchParams.get("ref")).toBe(COMMIT);
			const second = url.searchParams.get("page_token") === "next";
			const link = `<${BASE}/api/v4/projects/7/repository/tree?ref=${COMMIT}&recursive=true&per_page=100&pagination=keyset&page_token=next>; rel="next"`;
			return Response.json(
				second
					? [...entries.slice(1), { id: "d".repeat(40), type: "tree", path: "src", mode: "040000" }]
					: entries.slice(0, 1),
				{
					headers: second ? {} : { link },
				},
			);
		}
		const blob = /^\/projects\/7\/repository\/blobs\/([0-9a-f]+)\/raw$/.exec(path);
		if (blob?.[1] && blobs.has(blob[1])) return new Response(blobs.get(blob[1]));
		return new Response("", { status: 404 });
	};
	return { fetcher, requests };
}

function project(id: number, path: string, namespace: string, overrides = {}) {
	return {
		id,
		path,
		path_with_namespace: `${namespace}/${path}`,
		namespace: { full_path: namespace },
		default_branch: "main",
		visibility: "private",
		web_url: `${BASE}/${namespace}/${path}`,
		archived: false,
		...overrides,
	};
}

const push = (overrides: Record<string, unknown> = {}) => ({
	object_kind: "push",
	ref: "refs/heads/main",
	after: COMMIT,
	project: { id: 7, default_branch: "main" },
	...overrides,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GitLab connections", () => {
	it("refuse a token GitLab does not accept, and keep nothing", async () => {
		const stub = registry();
		vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitLab({ token: "other" }).fetcher);
		expect(await stub.gitlabConnect({ baseUrl: BASE, token: TOKEN }, "user-ada")).toEqual({
			status: "refused",
			message: "GitLab did not accept the token",
		});
		expect(await stub.gitlabConnections()).toEqual([]);
		expect(await stub.listRepositories()).toEqual([]);
	});

	it("bring in the projects the token reaches, keeping the token sealed", async () => {
		const stub = registry();
		const gitlab = fakeGitLab({
			projects: [
				project(7, "shop", "acme/web"),
				project(8, "empty", "acme", { default_branch: null }),
				project(9, "old", "acme", { archived: true }),
				// A page elsewhere is not followed: the link is made from the connection's address.
				project(11, "sneaky", "acme", { web_url: "javascript:alert(1)" }),
			],
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(gitlab.fetcher);
		const connected = await stub.gitlabConnect({ baseUrl: `${BASE}/`, token: TOKEN }, "user-ada");
		if ("status" in connected) throw new Error(connected.message);
		expect(connected.webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(connected.connection).toMatchObject({
			baseUrl: BASE,
			account: "project_7_bot",
			tokenHint: "1234",
			repositories: 2,
			createdBy: "user-ada",
		});
		// The token goes to GitLab only, and a redirect would not take it elsewhere.
		expect(gitlab.requests.every((request) => request.url.startsWith(`${BASE}/api/v4/`))).toBe(
			true,
		);
		expect(gitlab.requests.every((request) => request.redirect === "manual")).toBe(true);

		// Empty and archived projects have nothing to scan.
		const found = await stub.listRepositories();
		expect(
			found
				.map(({ name, webUrl }) => ({ name, webUrl }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual([
			{ name: "shop", webUrl: `${BASE}/acme/web/shop` },
			{ name: "sneaky", webUrl: `${BASE}/acme/sneaky` },
		]);
		expect(found.find((repository) => repository.name === "shop")).toMatchObject({
			provider: "gitlab",
			externalId: "gitlab.example.test:7",
			installationId: connected.connection.id,
			owner: "acme/web",
			name: "shop",
			defaultBranch: "main",
			private: true,
		});
		const stored = await runInDurableObject(stub, (instance: RegistryDO) => {
			const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
			return JSON.stringify(sql.exec("SELECT * FROM gitlab_connections").toArray());
		});
		expect(stored).not.toContain(TOKEN);
		expect(stored).not.toContain(connected.webhookSecret);
		expect(JSON.stringify(await stub.gitlabConnections())).not.toContain(TOKEN);
	});

	it("scan a project's default branch through GitLab, as a GitHub repository is", async () => {
		const stub = registry();
		vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitLab().fetcher);
		const connected = await stub.gitlabConnect({ baseUrl: BASE, token: TOKEN }, "user-ada");
		if ("status" in connected) throw new Error(connected.message);
		const [repository] = await stub.listRepositories();
		await runDurableObjectAlarm(stub);
		await vi.waitFor(async () => {
			expect((await stub.getRepository(repository?.id ?? ""))?.repository.scannedCommit).toBe(
				COMMIT,
			);
		});
		const detail = await stub.getRepository(repository?.id ?? "");
		expect(detail?.repository.scanError).toBeNull();
		expect(detail?.agents.map((agent) => agent.runtime)).toEqual(["claude-code"]);
		expect(detail?.assets.map((asset) => asset.name).sort()).toEqual(["CLAUDE.md", "review"]);
	});

	it("rescan on a push to the default branch only once the secret token matches", async () => {
		const stub = registry();
		vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitLab().fetcher);
		const connected = await stub.gitlabConnect({ baseUrl: BASE, token: TOKEN }, "user-ada");
		if ("status" in connected) throw new Error(connected.message);
		const { id } = connected.connection;
		const secret = connected.webhookSecret;

		expect(await stub.gitlabDelivery("missing", secret, push())).toBe("unknown");
		expect(await stub.gitlabDelivery(id, "wrong", push())).toBe("unauthorized");
		expect((await stub.gitlabConnections())[0]?.lastDeliveryAt).toBeNull();
		expect(await stub.gitlabDelivery(id, secret, push({ ref: "refs/heads/feature" }))).toBe(
			"ignored",
		);
		expect(await stub.gitlabDelivery(id, secret, push({ after: "0".repeat(40) }))).toBe("ignored");
		expect(await stub.gitlabDelivery(id, secret, { object_kind: "tag_push" })).toBe("ignored");
		expect(await stub.gitlabDelivery(id, secret, push())).toBe("queued");
		expect((await stub.gitlabConnections())[0]?.lastDeliveryAt).toEqual(expect.any(Number));

		// A new secret token replaces the old one.
		const renewed = await stub.gitlabNewWebhookSecret(id);
		if (typeof renewed !== "string") throw new Error(renewed.message);
		expect(await stub.gitlabDelivery(id, secret, push())).toBe("unauthorized");
		expect(await stub.gitlabDelivery(id, renewed, push())).toBe("queued");
	});

	it("follow the projects on a sync, and remove them on disconnecting", async () => {
		const stub = registry();
		vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitLab().fetcher);
		const connected = await stub.gitlabConnect({ baseUrl: BASE, token: TOKEN }, "user-ada");
		if ("status" in connected) throw new Error(connected.message);
		const { id } = connected.connection;

		vi.spyOn(globalThis, "fetch").mockImplementation(
			fakeGitLab({ projects: [project(7, "shop", "acme/web"), project(10, "api", "acme")] })
				.fetcher,
		);
		expect(await stub.gitlabSync(id)).toMatchObject({ repositories: 2, syncError: null });
		expect((await stub.listRepositories()).map((repository) => repository.name).sort()).toEqual([
			"api",
			"shop",
		]);

		vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitLab({ token: "revoked" }).fetcher);
		expect(await stub.gitlabSync(id)).toEqual({
			status: "refused",
			message: "GitLab did not accept the token",
		});
		expect((await stub.gitlabConnections())[0]).toMatchObject({
			repositories: 2,
			syncError: "GitLab did not accept the token",
		});

		expect(await stub.gitlabDisconnect(id)).toBe(true);
		expect(await stub.gitlabConnections()).toEqual([]);
		expect(await stub.listRepositories()).toEqual([]);
		expect(await stub.gitlabDelivery(id, connected.webhookSecret, push())).toBe("unknown");
	});

	it("refuse an address that is not https", async () => {
		const stub = registry();
		await runInDurableObject(stub, async (instance: RegistryDO) => {
			await expect(
				instance.gitlabConnect({ baseUrl: "http://gitlab.example.test", token: TOKEN }, "user-ada"),
			).rejects.toThrow(/https/);
			await expect(
				instance.gitlabConnect(
					{ baseUrl: "https://me:pw@gitlab.example.test", token: TOKEN },
					"user-ada",
				),
			).rejects.toThrow(/without a token/);
		});
	});
});
