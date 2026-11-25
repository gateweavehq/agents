import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { connectAgent, MemoryProvider } from "./mcp-client";
import { callServerFn, serverFnRequest } from "./server-fn";

const origin = "https://agents.test";
let agents: Awaited<ReturnType<typeof startAgents>>;
beforeAll(async () => {
	agents = await startAgents(origin);
});
afterAll(async () => {
	await agents?.dispose();
});

async function workspace(slug: string) {
	const owner = await signUp(agents, origin, slug);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	const data = { slug, agentId: agent.id };
	const call = (action: string, headers: typeof owner.headers) =>
		callServerFn(agents, origin, action, {
			data,
			cookie: headers.cookie,
			client: headers["cf-connecting-ip"],
		});
	const join = async (role: string) => {
		const person = await signUp(agents, origin, `${slug}-${role}`);
		await agents.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), workspaceId, person.userId, role, Date.now())
			.run();
		return person;
	};
	return { owner, registry, workspaceId, data, call, join };
}

it("refuses a plain member both actions", async () => {
	const { owner, registry, data, call, join } = await workspace("pause-member");
	const member = await join("member");
	expect((await call("pauseAgent", member.headers)).text).toContain("Only admins can do this");
	expect((await registry.getAgent(data.agentId))?.agent.paused).toBeNull();
	expect((await call("pauseAgent", owner.headers)).failed).toBe(false);
	expect((await call("resumeAgent", member.headers)).text).toContain("Only admins can do this");
	expect((await registry.getAgent(data.agentId))?.agent.paused?.by).toBe(owner.userId);
});

it("lets a stale admin pause and requires a fresh sign-in to resume", async () => {
	const { registry, workspaceId, data, call, join } = await workspace("pause-admin");
	const admin = await join("admin");
	await agents.db
		.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
		.bind(Date.now() - 3 * 86400000, admin.userId)
		.run();
	const paused = await call("pauseAgent", admin.headers);
	expect(paused.failed, paused.text).toBe(false);
	expect((await call("resumeAgent", admin.headers)).text).toContain("Sign in again");
	expect((await registry.getAgent(data.agentId))?.agent.paused?.by).toBe(admin.userId);
	const signed = await agents.fetch(`${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: admin.headers,
		body: JSON.stringify({ email: "pause-admin-admin@example.com", password: "a-long-password" }),
	});
	expect(signed.status).toBe(200);
	const cookie = signed.headers
		.getSetCookie()
		.map((s) => s.split(";")[0])
		.join("; ");
	const resumed = await call("resumeAgent", { ...admin.headers, cookie });
	expect(resumed.failed, resumed.text).toBe(false);
	expect((await registry.getAgent(data.agentId))?.agent.paused).toBeNull();
	const events = await agents.db
		.prepare(
			"SELECT action,actor_id FROM audit_event WHERE organization_id = ? AND target_id = ? ORDER BY id",
		)
		.bind(workspaceId, data.agentId)
		.all();
	expect(events.results).toEqual([
		{ action: "agent.paused", actor_id: admin.userId },
		{ action: "agent.resumed", actor_id: admin.userId },
	]);
});

it("offers neither action to an MCP client or its bearer token alone", async () => {
	const { owner, data } = await workspace("pause-mcp");
	const provider = new MemoryProvider();
	const client = await connectAgent(agents, origin, owner.headers.cookie, provider);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((name) => /pause|resume/i.test(name))).toEqual([]);
		const token = provider.tokens()?.access_token;
		expect(token).toBeTruthy();
		for (const action of ["pauseAgent", "resumeAgent"]) {
			const result = await agents.fetch(
				serverFnRequest(origin, action, {
					data,
					headers: { origin, authorization: `Bearer ${token}` },
				}),
			);
			expect(await result.text()).toContain("Only admins can do this");
		}
	} finally {
		await client.close();
	}
});
