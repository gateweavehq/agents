import { afterAll, beforeAll, expect, it } from "vitest";
import { inputOf } from "../src/lib/agent-input";
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

function call(name: string, who: Person, data: Record<string, unknown>) {
	return callServerFn(agents, origin, name, {
		data,
		cookie: who.headers.cookie,
		client: who.headers["cf-connecting-ip"],
	});
}

async function auditOf(workspaceId: string) {
	const { results } = await agents.db
		.prepare(
			"SELECT action, target_id, detail FROM audit_event WHERE organization_id = ? AND action LIKE 'agent.%' ORDER BY id",
		)
		.bind(workspaceId)
		.all();
	return (results as { action: string; target_id: string | null; detail: string }[]).map((row) => ({
		action: row.action,
		agent: row.target_id,
		detail: JSON.parse(row.detail) as Record<string, unknown>,
	}));
}

/**
 * A workspace whose agent runs Claude Code in a sandbox with memory on, none of them the default,
 * and pins instructions that have a second version since.
 */
async function workspace(slug: string) {
	const owner = await signUp(agents, origin, `ada-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const rules = await registry.createLibraryAsset({
		kind: "instructions",
		name: "Rules",
		text: "Be brief.\n",
	});
	const agent = await registry.createAgent({
		name: "Coder",
		description: "Writes the code.",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: rules, version: 1 },
		sandbox: true,
		engine: "claude-code",
		memory: true,
	});
	const [file] = (await registry.getAsset(rules))?.version.files ?? [];
	expect(
		await registry.editLibraryAsset({
			libraryAssetId: rules,
			files: [{ path: file?.path ?? "", content: "Be brief, and kind.\n" }],
		}),
	).toBe(2);
	return { owner, workspaceId, registry, rules, agent };
}

it("keeps an agent's engine and memory when a page saves it whole to change one thing (AGT-135)", async () => {
	const { owner, workspaceId, registry, rules, agent } = await workspace("pin-whole");
	const shown = await registry.getAgent(agent.id);
	if (!shown?.definition) throw new Error("No definition");

	// What "Use v2" sent before it named the pin alone, and what the form's Save starts from:
	// the agent as it is shown, with the one thing changed.
	const input = { ...inputOf(shown.agent, shown.definition) };
	input.instructions = { assetId: rules, version: 2 };
	const saved = await call("updateAgent", owner, {
		slug: "pin-whole",
		agentId: agent.id,
		agent: input,
		expectedRevision: shown.agent.updatedAt,
	});
	expect(saved.failed, saved.text).toBe(false);

	const after = (await registry.getAgent(agent.id))?.definition;
	expect(after?.instructions?.version).toBe(2);
	expect(after).toMatchObject({ sandbox: true, engine: "claude-code", memory: true });
	expect(await registry.agentSnapshot(agent.id)).toMatchObject({
		engine: "claude-code",
		memory: true,
	});
	// The log names the pin, and nothing the save did not mean to change.
	expect(await auditOf(workspaceId)).toEqual([
		{ action: "agent.updated", agent: agent.id, detail: { fields: ["instructions"] } },
	]);
});

it("rejects short and stale full saves without replacing a newer pin", async () => {
	const { owner, registry, rules, agent } = await workspace("pin-conflict");
	const shown = await registry.getAgent(agent.id);
	if (!shown?.definition) throw new Error("No definition");
	const input = inputOf(shown.agent, shown.definition);
	const short = { ...input };
	delete (short as Partial<typeof input>).outsideTasks;
	const old = await call("updateAgent", owner, {
		slug: "pin-conflict",
		agentId: agent.id,
		agent: short,
	});
	expect(old.failed).toBe(true);
	expect(old.text).toContain("Reload this page and reopen the agent before saving");
	const omitted = await call("updateAgent", owner, {
		slug: "pin-conflict",
		agentId: agent.id,
		agent: short,
		expectedRevision: shown.agent.updatedAt,
	});
	expect(omitted.failed).toBe(true);
	const moved = await call("moveAgentPin", owner, {
		slug: "pin-conflict",
		agentId: agent.id,
		pin: { assetId: rules, version: 2 },
	});
	expect(moved.failed, moved.text).toBe(false);
	const stale = await call("updateAgent", owner, {
		slug: "pin-conflict",
		agentId: agent.id,
		agent: input,
		expectedRevision: shown.agent.updatedAt,
	});
	expect(stale.failed).toBe(true);
	expect(stale.text).toContain("Agent changed since you opened it");
	expect((await registry.getAgent(agent.id))?.definition?.instructions?.version).toBe(2);
});

it("moves a pin by naming it alone, for owners and admins only, and logs what moved", async () => {
	const { owner, workspaceId, registry, rules, agent } = await workspace("pin-alone");
	const before = (await registry.getAgent(agent.id))?.definition;
	const pin = { assetId: rules, version: 2 };

	// A member who is not an admin, and someone outside the workspace, move nothing.
	const member = await signUp(agents, origin, "grace-pin-alone");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, member.userId, Date.now())
		.run();
	const outsider = await signUp(agents, origin, "eve-pin-alone");
	for (const who of [member, outsider]) {
		const refused = await call("moveAgentPin", who, { slug: "pin-alone", agentId: agent.id, pin });
		expect(refused.failed, refused.text).toBe(true);
		expect(refused.text).toContain("Only admins can do this");
	}
	expect((await registry.getAgent(agent.id))?.definition).toEqual(before);
	expect(await auditOf(workspaceId)).toEqual([]);

	// The call has no place for anything but the pin: what else is sent is not read.
	const moved = await call("moveAgentPin", owner, {
		slug: "pin-alone",
		agentId: agent.id,
		pin: { ...pin, engine: "gateweave", memory: false },
		agent: { engine: "gateweave", memory: false },
	});
	expect(moved.failed, moved.text).toBe(false);
	const after = (await registry.getAgent(agent.id))?.definition;
	expect(after?.instructions?.version).toBe(2);
	expect(after).toEqual({
		...before,
		instructions: before?.instructions && { ...before.instructions, version: 2 },
	});
	expect(await registry.agentSnapshot(agent.id)).toMatchObject({
		instructions: "Be brief, and kind.\n",
		sandbox: true,
		engine: "claude-code",
		memory: true,
	});
	expect(await auditOf(workspaceId)).toEqual([
		{
			action: "agent.updated",
			agent: agent.id,
			detail: { fields: ["instructions"], asset: "Rules", from: 1, version: 2 },
		},
	]);

	// Moving it to where it is changes nothing, so nothing is logged; a refusal says why.
	const again = await call("moveAgentPin", owner, { slug: "pin-alone", agentId: agent.id, pin });
	expect(again.failed, again.text).toBe(false);
	const missing = await call("moveAgentPin", owner, {
		slug: "pin-alone",
		agentId: agent.id,
		pin: { assetId: rules, version: 9 },
	});
	expect(missing.failed, missing.text).toBe(true);
	expect(missing.text).toContain("Rules has no version 9");
	expect(await auditOf(workspaceId)).toHaveLength(1);

	// An admin, who is not the owner, may move it too: here back to the older version.
	const admin = await signUp(agents, origin, "linus-pin-alone");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, admin.userId, Date.now())
		.run();
	const back = await call("moveAgentPin", admin, {
		slug: "pin-alone",
		agentId: agent.id,
		pin: { assetId: rules, version: 1 },
	});
	expect(back.failed, back.text).toBe(false);
	expect((await registry.getAgent(agent.id))?.definition).toEqual(before);
	expect((await auditOf(workspaceId)).at(-1)).toEqual({
		action: "agent.updated",
		agent: agent.id,
		detail: { fields: ["instructions"], asset: "Rules", from: 2, version: 1 },
	});
	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
});

it("only lets managers change the agent's target settings and logs the fields they changed", async () => {
	const slug = "agent-targets";
	const { owner, workspaceId, registry, agent } = await workspace(slug);
	const shown = await registry.getAgent(agent.id);
	if (!shown?.definition) throw new Error("No definition");
	const data = {
		slug,
		agentId: agent.id,
		agent: {
			...inputOf(shown.agent, shown.definition),
			allowedTargets: ["@Example.NET"],
			anyTarget: true,
		},
	};
	const member = await signUp(agents, origin, "grace-agent-targets");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, member.userId, Date.now())
		.run();
	expect((await call("updateAgent", member, data)).failed).toBe(true);
	expect(await auditOf(workspaceId)).toEqual([]);
	const saved = await call("updateAgent", owner, data);
	expect(saved.failed, saved.text).toBe(false);
	expect((await registry.getAgent(agent.id))?.definition).toMatchObject({
		allowedTargets: ["@example.net"],
		anyTarget: true,
	});
	expect(await auditOf(workspaceId)).toEqual([
		{
			action: "agent.updated",
			agent: agent.id,
			detail: {
				fields: ["allowedTargets", "anyTarget"],
				allowedTargetCount: 1,
				addedTargets: ["@example.net"],
				removedTargets: [],
				previousAnyTarget: false,
				anyTarget: true,
			},
		},
	]);
	const entries = Array.from(
		{ length: 12 },
		(_, i) => "host" + String(i).padStart(2, "0") + ".example",
	);
	const changed = await call("updateAgent", owner, {
		...data,
		agent: { ...data.agent, allowedTargets: entries },
	});
	expect(changed.failed, changed.text).toBe(false);
	expect((await auditOf(workspaceId)).at(-1)?.detail).toEqual({
		fields: ["allowedTargets"],
		allowedTargetCount: 12,
		addedTargets: [...entries.slice(0, 10), "and 2 more"],
		removedTargets: ["@example.net"],
	});
});
