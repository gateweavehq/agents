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

it("lets only a fresh owner or admin session set model-key spending caps", async () => {
	const owner = await signUp(agents, origin, "caps-owner");
	const slug = "caps";
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Owner");
	const data = { slug, caps: { daily: "1", monthly: "20" } };
	const call = (headers: typeof owner.headers) =>
		callServerFn(agents, origin, "saveModelKeyCaps", {
			data,
			cookie: headers.cookie,
			client: headers["cf-connecting-ip"],
		});

	const member = await signUp(agents, origin, "caps-member");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, member.userId, "member", Date.now())
		.run();
	expect((await call(member.headers)).text).toContain("Only admins can do this");

	await agents.db
		.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
		.bind(Date.now() - 3 * 86400000, owner.userId)
		.run();
	expect((await call(owner.headers)).text).toContain("Sign in again");
	expect((await registry.getModelKeyCaps()).dailyCap).toBeNull();

	const signed = await agents.fetch(`${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: owner.headers,
		body: JSON.stringify({ email: "caps-owner@example.com", password: "a-long-password" }),
	});
	expect(signed.status).toBe(200);
	const cookie = signed.headers
		.getSetCookie()
		.map((part) => part.split(";")[0])
		.join("; ");
	const saved = await call({ ...owner.headers, cookie });
	expect(saved.failed, saved.text).toBe(false);
	expect(await registry.getModelKeyCaps()).toEqual({ dailyCap: "1", monthlyCap: "20" });
});
