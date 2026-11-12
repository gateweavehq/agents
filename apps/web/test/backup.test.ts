import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { ask } from "./chat-socket";
import { FakeModels } from "./fake-models";

// Gateweave Backup reaches the registries and conversations only through the named Backup
// entrypoint, over a service binding, as a backup Worker in the same account would.

const origin = "https://agents.test";
const KEY = "sk-ant-api03-correct-horse-battery";

const models = new FakeModels({ [KEY]: { provider: "anthropic", models: ["claude-sonnet-5-5"] } });

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { models });
});

afterAll(async () => {
	await agents?.dispose();
});

type Page = { names: string[]; cursor?: string };

/** A workspace whose owner talked to its agent, Reviewer, in one conversation. */
async function workspaceWithChat(slug: string) {
	const owner = await signUp(agents, origin, `ada-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	const registry = await agents.registry(workspaceId);
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
	});
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const conversation = await registry.startConversation(agent.id, owner.userId);
	if (!conversation) throw new Error("The conversation did not start");
	const url = `${origin}/api/chat/${slug}/${conversation.id}`;
	const { socket } = await agents.connect(url, { cookie: owner.headers.cookie, origin });
	if (!socket) throw new Error("No WebSocket");
	expect((await ask(socket, "Kept in the backup")).text).toBe("Looks good.");
	socket.close();
	return { owner, workspaceId, registry, conversation };
}

/** Every name the entrypoint lists, page after page. */
async function everyObject() {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await agents.backup<Page>("objects", ...(cursor === undefined ? [] : [cursor]));
		if (!page.result) throw new Error(page.error);
		names.push(...page.result.names);
		cursor = page.result.cursor;
	} while (cursor !== undefined);
	return names;
}

describe("the Backup entrypoint", () => {
	it("lists each registry and conversation, and reads one's object, rolled back", async () => {
		const { workspaceId, conversation } = await workspaceWithChat("backed-up");
		const names = await everyObject();
		const registry = `registry.${workspaceId}`;
		const chat = `conversation.${workspaceId}.${conversation.id}`;
		expect(names).toContain(registry);
		expect(names).toContain(chat);
		// A workspace's conversations follow its registry.
		expect(names.indexOf(chat)).toBe(names.indexOf(registry) + 1);

		const agentsRead = await agents.backup<unknown[][]>("read", registry, [
			"SELECT name FROM agents",
		]);
		expect(agentsRead).toEqual({ result: [[{ name: "Reviewer" }]] });

		// The Agents SDK keeps a conversation's messages in its own SQLite tables.
		const messages = await agents.backup<{ role: string; kept: number }[][]>("read", chat, [
			"SELECT role, instr(content, 'Kept in the backup') > 0 AS kept FROM cf_agents_session_messages ORDER BY seq",
		]);
		expect(messages.result?.[0]).toEqual([
			{ role: "user", kept: 1 },
			{ role: "assistant", kept: 0 },
		]);
	});

	it("refuses a write, and answers null for an object that isn't there", async () => {
		const { owner, workspaceId, registry, conversation } = await workspaceWithChat("read-only");
		const write = await agents.backup("read", `registry.${workspaceId}`, ["DELETE FROM agents"]);
		expect(write.error).toMatch(/^The object refused the backup's read\. A backup only reads/);
		const kept = await agents.backup<unknown[][]>("read", `registry.${workspaceId}`, [
			"SELECT name FROM agents",
		]);
		expect(kept.result).toEqual([[{ name: "Reviewer" }]]);

		const missing = [
			`registry.${crypto.randomUUID()}`,
			`conversation.${workspaceId}.${crypto.randomUUID()}`,
			`conversation.${crypto.randomUUID()}.${conversation.id}`,
			`registry.${workspaceId}.extra`,
			`workspace.${workspaceId}`,
			`registry.../${workspaceId}`,
			"registry",
			42,
		];
		for (const name of missing) {
			expect(await agents.backup("read", name, ["SELECT 1 AS one"]), String(name)).toEqual({
				result: null,
			});
		}

		// A conversation deleted after the list was made is gone too.
		const chat = `conversation.${workspaceId}.${conversation.id}`;
		await registry.removeConversation(conversation.id, owner.userId);
		expect(await agents.backup("read", chat, ["SELECT 1 AS one"])).toEqual({ result: null });
	});

	it("pages through the workspaces in order", async () => {
		const ids = Array.from({ length: 45 }, (_, i) => `paged-${String(i).padStart(3, "0")}`);
		await agents.db.batch(
			ids.map((id) =>
				agents.db
					.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 0)")
					.bind(id, id, id),
			),
		);
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await agents.backup<Page>("objects", ...(cursor === undefined ? [] : [cursor]));
			if (!page.result) throw new Error(page.error);
			seen.push(...page.result.names);
			cursor = page.result.cursor;
			pages++;
		} while (cursor !== undefined);
		expect(pages).toBeGreaterThanOrEqual(3);
		const paged = seen.filter((name) => name.startsWith("registry.paged-"));
		expect(paged).toEqual(ids.map((id) => `registry.${id}`));
		expect(new Set(seen).size).toBe(seen.length);

		const bad = await agents.backup("objects", "../up");
		expect(bad.error).toBeDefined();
	});
});
