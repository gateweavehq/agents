import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { fromWorkerOn, whileJunkGoesOn } from "./workers";

const origin = "https://agents.test";
const GITLAB = "https://gitlab.test";
const TOKEN = "glpat-webtest0000000wxyz";

/** gitlab.test's API, as small as connecting needs: who the token is, and one project. */
function gitlab(request: Request): Response {
	const url = new URL(request.url);
	if (request.headers.get("PRIVATE-TOKEN") !== TOKEN) return new Response("", { status: 401 });
	if (url.pathname === "/api/v4/user") return Response.json({ username: "group_5_bot" });
	if (url.pathname === "/api/v4/projects") {
		return Response.json([
			{
				id: 42,
				path: "storefront",
				path_with_namespace: "acme/storefront",
				namespace: { full_path: "acme" },
				default_branch: "main",
				visibility: "private",
				web_url: `${GITLAB}/acme/storefront`,
				archived: false,
			},
		]);
	}
	// An empty repository: scanning it is the registry tests' business.
	if (url.pathname === "/api/v4/projects/42/repository/branches/main") {
		return Response.json({ commit: { id: "c".repeat(40) } });
	}
	if (url.pathname === "/api/v4/projects/42/repository/tree") return Response.json([]);
	return new Response("", { status: 404 });
}

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { hosts: { "gitlab.test": gitlab } });
});

afterAll(async () => {
	await agents?.dispose();
});

async function connected(slug: string) {
	const owner = await signUp(agents, origin, `owner-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const made = await registry.gitlabConnect({ baseUrl: GITLAB, token: TOKEN }, "owner");
	if ("status" in made) throw new Error(made.message);
	return { owner, workspaceId, registry, ...made };
}

const page = async (path: string, cookie: string) =>
	(await (await agents.fetch(`${origin}${path}`, { headers: { cookie } })).text()).replaceAll(
		"<!-- -->",
		"",
	);

const deliver = (
	path: string,
	token: string | null,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	agents.fetch(`${origin}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-gitlab-event": "Push Hook",
			...(token === null ? {} : { "x-gitlab-token": token }),
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

const push = {
	object_kind: "push",
	ref: "refs/heads/main",
	after: "c".repeat(40),
	project: { id: 42, default_branch: "main" },
};

it("shows a connection to owners and admins with its webhook, and never its token", async () => {
	const { owner, workspaceId, connection, webhookSecret } = await connected("gl-lab");
	const settings = await page("/gl-lab/settings/gitlab", owner.headers.cookie);
	expect(settings).toContain("gitlab.test");
	expect(settings).toContain("As group_5_bot · token ending wxyz · 1 project");
	expect(settings).toContain(`${origin}/api/gitlab/webhooks/${workspaceId}/${connection.id}`);
	expect(settings).not.toContain(TOKEN);
	expect(settings).not.toContain(webhookSecret);

	// The project is a repository, linked to its page on that GitLab.
	const repositories = await page("/gl-lab/repositories", owner.headers.cookie);
	expect(repositories).toContain("storefront");

	// A member sees the connection, but not where its webhook is, nor the form.
	const member = await signUp(agents, origin, "member-gl-lab");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, member.userId, Date.now())
		.run();
	const seen = await page("/gl-lab/settings/gitlab", member.headers.cookie);
	expect(seen).toContain("gitlab.test");
	expect(seen).not.toContain("/api/gitlab/webhooks/");
	expect(seen).not.toContain("Connect a GitLab");

	// Someone outside the workspace sees nothing of it.
	const stranger = await signUp(agents, origin, "stranger-gl-lab");
	const outside = await page("/gl-lab/settings/gitlab", stranger.headers.cookie);
	expect(outside).not.toContain("group_5_bot");
	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
});

it("counts Workers on different zones apart, so junk from one is not another's problem", async () => {
	const { workspaceId, connection, webhookSecret } = await connected("gl-zones");
	const path = `/api/gitlab/webhooks/${workspaceId}/${connection.id}`;
	const { answer, statuses } = await whileJunkGoesOn(
		() => deliver(path, null, push, fromWorkerOn("junk.example")),
		120,
		() => deliver(path, webhookSecret, push, fromWorkerOn("other.example")),
	);
	expect(statuses).toContain(429);
	expect(answer.status).not.toBe(429);
});

it("takes a push only with the connection's secret token, and queues a scan", async () => {
	const { workspaceId, registry, connection, webhookSecret } = await connected("gl-hooks");
	const path = `/api/gitlab/webhooks/${workspaceId}/${connection.id}`;

	expect((await deliver(path, null, push)).status).toBe(404);
	expect((await deliver(path, "not-the-secret", push)).status).toBe(404);
	expect(
		(await deliver(`/api/gitlab/webhooks/missing/${connection.id}`, webhookSecret, push)).status,
	).toBe(404);
	expect(
		(await deliver(`/api/gitlab/webhooks/${workspaceId}/missing`, webhookSecret, push)).status,
	).toBe(404);
	expect((await deliver(path, webhookSecret, "not json")).status).toBe(400);
	expect((await deliver(path, webhookSecret, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
	expect((await registry.gitlabConnections())[0]?.lastDeliveryAt).toBeNull();

	expect((await deliver(path, webhookSecret, { ...push, ref: "refs/heads/feature" })).status).toBe(
		202,
	);
	expect((await deliver(path, webhookSecret, push)).status).toBe(204);
	expect((await registry.gitlabConnections())[0]?.lastDeliveryAt).toEqual(expect.any(Number));
});
