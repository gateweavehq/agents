import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { ask } from "./chat-socket";
import { FakeModels } from "./fake-models";

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

/** A workspace whose owner started a conversation with its agent, Reviewer. */
async function conversationWith(slug: string, { key = true } = {}) {
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
	if (key) await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const conversation = await registry.startConversation(agent.id, owner.userId);
	if (!conversation) throw new Error("The conversation did not start");
	return {
		owner,
		workspaceId,
		registry,
		path: `/api/chat/${slug}/${conversation.id}`,
		conversation,
	};
}

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments.
	return (await response.text()).replaceAll("<!-- -->", "");
}

it("lets the member who started a conversation talk to the agent through the gateway", async () => {
	const { owner, path, conversation } = await conversationWith("chat-forge");
	const cookie = owner.headers.cookie;

	const before = await agents.fetch(`${origin}${path}/get-messages`, { headers: { cookie } });
	expect(before.status).toBe(200);
	expect(await before.json()).toEqual([]);

	const { status, socket } = await agents.connect(`${origin}${path}`, { cookie, origin });
	expect(status).toBe(101);
	if (!socket) throw new Error("No WebSocket");
	const turn = await ask(socket, "Review my change, please");
	socket.close();
	expect(turn.text).toBe("Looks good.");
	// The workspace's key went to the provider, and never back to the browser.
	const request = models.requests.at(-1);
	expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
	expect(request?.headers.get("x-api-key")).toBe(KEY);
	expect(request?.body).toContain("Review my change, please");
	expect(turn.raw.join("")).not.toContain("correct-horse");

	const after = await agents.fetch(`${origin}${path}/get-messages`, { headers: { cookie } });
	const messages = (await after.json()) as { role: string }[];
	expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);

	// The first message titles the conversation, in the list and on its page.
	expect(await page("/chat-forge/chat", cookie)).toContain("Review my change, please");
	const html = await page(`/chat-forge/chat/${conversation.id}`, cookie);
	expect(html).toContain("Review my change, please");
	expect(html).toContain("claude-sonnet-5-5");
	expect(html).not.toContain("correct-horse");
});

it("keeps a conversation from everyone but the member who started it", async () => {
	const { workspaceId, path, conversation, registry } = await conversationWith("chat-guild");
	const url = `${origin}${path}`;

	// Signed out, cross-site, or not a WebSocket: nothing reaches the conversation.
	expect((await agents.fetch(`${url}/get-messages`)).status).toBe(401);
	expect((await agents.connect(url, { origin })).status).toBe(401);
	expect((await agents.fetch(url, { headers: { origin } })).status).toBe(426);

	// Another member of the workspace gets the answer a missing conversation gets.
	const grace = await signUp(agents, origin, "grace-chat");
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, grace.userId, Date.now())
		.run();
	const theirs = { cookie: grace.headers.cookie, origin };
	expect((await agents.connect(url, { ...theirs, origin: "https://evil.test" })).status).toBe(403);
	const read = await agents.fetch(`${url}/get-messages`, { headers: theirs });
	expect(read.status).toBe(404);
	expect(await read.json()).toEqual({ error: "Conversation not found" });
	expect((await agents.connect(url, theirs)).status).toBe(404);
	expect(
		(await agents.fetch(`${origin}/api/chat/chat-guild/missing/get-messages`, { headers: theirs }))
			.status,
	).toBe(404);
	expect(await page(`/chat-guild/chat/${conversation.id}`, grace.headers.cookie)).toContain(
		"Conversation not found",
	);
	expect(await page("/chat-guild/chat", grace.headers.cookie)).toContain("Nobody else sees them");
	expect(await registry.getConversation(conversation.id, grace.userId)).toBeNull();

	// So does someone from outside the workspace.
	const eve = await signUp(agents, origin, "eve-chat");
	const outsider = { cookie: eve.headers.cookie, origin };
	expect((await agents.fetch(`${url}/get-messages`, { headers: outsider })).status).toBe(404);
	expect((await agents.connect(url, outsider)).status).toBe(404);
});

it("says why an agent cannot answer when the workspace has no key for its provider", async () => {
	const { owner, conversation } = await conversationWith("chat-atelier", { key: false });
	const html = await page(`/chat-atelier/chat/${conversation.id}`, owner.headers.cookie);
	expect(html).toContain("The workspace has no Anthropic key, so Reviewer cannot answer yet.");
	expect(html).toContain("Add one in Settings");
	// The agent list says so before a conversation starts, too.
	expect(await page("/chat-atelier/chat", owner.headers.cookie)).toContain("no Anthropic key yet");
});
