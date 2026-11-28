import { REVIEW_GATE } from "@gateweave/agents-model";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { callServerFn } from "./server-fn";

const origin = "https://agents.test";
const KEY = "sk-ant-api03-correct-horse-battery";
let agents: Awaited<ReturnType<typeof startAgents>>;
let counter = 0;

beforeAll(async () => {
	agents = await startAgents(origin, { settings: { SANDBOX: "1" } });
});

afterAll(async () => {
	await agents?.dispose();
});

async function workspace() {
	const label = `review-${++counter}`;
	const owner = await signUp(agents, origin, `ada-${label}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, label);
	const registry = await agents.registry(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = ""] = await registry.syncRepositories([
		{
			provider: "github",
			externalId: `${counter}`,
			installationId: "99",
			owner: "acme",
			name: "site",
			defaultBranch: "main",
			private: true,
		},
	]);
	return { owner, slug: label, workspaceId, registry, repositoryId };
}

async function addMember(workspaceId: string, role: "admin" | "member") {
	const person = await signUp(agents, origin, `member-${++counter}`);
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, person.userId, role, Date.now())
		.run();
	return person;
}

function review(repositoryId: string, rest: Record<string, string> = {}) {
	return {
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		engine: "gateweave",
		repositoryId,
		...rest,
	};
}

async function call(person: Awaited<ReturnType<typeof signUp>>, slug: string, data: object) {
	return callServerFn(agents, origin, "setUpPullRequestReview", {
		data: { slug, review: data },
		cookie: person.headers.cookie,
		client: person.headers["cf-connecting-ip"],
	});
}

it("only an owner or admin sets up pull request review; a member cannot", async () => {
	const { slug, workspaceId, repositoryId, registry } = await workspace();
	const member = await addMember(workspaceId, "member");
	const refused = await call(member, slug, review(repositoryId));
	expect(refused.failed).toBe(true);
	expect(refused.text).toContain("Only admins can do this");
	expect(await registry.listTriggers()).toEqual([]);

	const admin = await addMember(workspaceId, "admin");
	const made = await call(admin, slug, review(repositoryId));
	if (REVIEW_GATE.passed === null) {
		expect(made.failed).toBe(true);
		expect(made.text).toContain("replay gate");
		expect(await registry.listTriggers()).toEqual([]);
	} else {
		expect(made.failed, made.text).toBe(false);
		expect((await registry.listTriggers()).filter((trigger) => trigger.pullRequest)).toHaveLength(
			1,
		);
	}
});

it("refuses a workspace without sandboxes before anything is made", async () => {
	const local = await startAgents(origin, {});
	try {
		const label = `review-nosandbox-${++counter}`;
		const owner = await signUp(local, origin, `ada-${label}`);
		const workspaceId = await createWorkspace(local, origin, owner.headers, label);
		const registry = await local.registry(workspaceId);
		await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		const [repositoryId = ""] = await registry.syncRepositories([
			{
				provider: "github",
				externalId: `plain-${counter}`,
				installationId: "99",
				owner: "acme",
				name: "site",
				defaultBranch: "main",
				private: true,
			},
		]);
		const answer = await callServerFn(local, origin, "setUpPullRequestReview", {
			data: { slug: label, review: review(repositoryId) },
			cookie: owner.headers.cookie,
			client: owner.headers["cf-connecting-ip"],
		});
		expect(answer.failed).toBe(true);
		expect(answer.text).toContain("does not run sandboxes");
		expect(await registry.listTriggers()).toEqual([]);
	} finally {
		await local.dispose();
	}
});
