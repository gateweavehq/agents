import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { ask } from "./chat-socket";
import { FakeModels } from "./fake-models";

const origin = "https://agents.test";
const TOKEN = "workers-ai-deployment-token-not-a-real-one";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";
const NO_TOOLS = "@cf/meta/llama-2-7b-chat-int8";
const COMPLETIONS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`;
const SEARCH = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search?task=Text+Generation&per_page=200`;

const models = new FakeModels({});
models.workersAi = {
	token: TOKEN,
	account: ACCOUNT,
	catalog: [
		{ name: SCOUT, functionCalling: true },
		{ name: "@cf/openai/gpt-oss-20b", functionCalling: true },
		{ name: NO_TOOLS, functionCalling: false },
	],
};

let on: Awaited<ReturnType<typeof startAgents>>;
let off: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	on = await startAgents(origin, {
		models,
		settings: { WORKERS_AI_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
	});
	off = await startAgents(origin, { models });
});

afterAll(async () => {
	await on?.dispose();
	await off?.dispose();
});

type Started = Awaited<ReturnType<typeof startAgents>>;

/** A workspace with a Workers AI agent and no model key at all, and its owner's conversation. */
async function conversationWith(server: Started, slug: string) {
	const owner = await signUp(server, origin, `ada-${slug}`);
	const workspaceId = await createWorkspace(server, origin, owner.headers, slug);
	const registry = await server.registry(workspaceId);
	const agent = await registry.createAgent({
		name: "Scout",
		description: null,
		provider: "workers-ai",
		model: SCOUT,
		instructions: null,
	});
	const conversation = await registry.startConversation(agent.id, owner.userId);
	if (!conversation) throw new Error("The conversation did not start");
	return { owner, registry, agent, conversation, path: `/api/chat/${slug}/${conversation.id}` };
}

async function page(server: Started, path: string, cookie: string) {
	const response = await server.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments.
	return (await response.text()).replaceAll("<!-- -->", "");
}

async function talk(server: Started, started: Awaited<ReturnType<typeof conversationWith>>) {
	const cookie = started.owner.headers.cookie;
	const { status, socket } = await server.connect(`${origin}${started.path}`, { cookie, origin });
	expect(status).toBe(101);
	if (!socket) throw new Error("No WebSocket");
	try {
		return await ask(socket, "Review my change, please");
	} finally {
		socket.close();
	}
}

it("answers a Workers AI agent with the deployment's token, and the workspace has no key", async () => {
	const started = await conversationWith(on, "wai-forge");
	const cookie = started.owner.headers.cookie;
	expect(await started.registry.listProviderKeys()).toEqual([]);

	const turn = await talk(on, started);
	expect(turn.text).toBe("Looks good.");
	const request = models.requests.findLast((seen) => seen.url === COMPLETIONS);
	expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
	expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
		model: SCOUT,
		stream: true,
		stream_options: { include_usage: true },
	});
	expect(request?.body).toContain("Review my change, please");

	// The run is the deployment's to pay for, and counted at Workers AI's own prices.
	const [run] = await started.registry.listRuns();
	expect(run).toMatchObject({
		status: "succeeded",
		provider: "workers-ai",
		inputTokens: 620,
		outputTokens: 5,
		// $0.27 and $0.85 per million tokens.
		cost: Math.round(620 * 0.27 + 5 * 0.85),
	});

	// The token reached Cloudflare and nothing else: not the browser, in a frame or on a page.
	expect(turn.raw.join("")).not.toContain(TOKEN);
	for (const path of [
		"/wai-forge/chat",
		`/wai-forge/chat/${started.conversation.id}`,
		`/wai-forge/agents/${started.agent.id}`,
		"/wai-forge/runs",
		"/wai-forge/settings/models",
	]) {
		expect(await page(on, path, cookie)).not.toContain(TOKEN);
	}
	const chat = await page(on, `/wai-forge/chat/${started.conversation.id}`, cookie);
	expect(chat).not.toContain("cannot answer");
});

it("refuses a turn up front on a server that did not turn Workers AI on", async () => {
	const started = await conversationWith(off, "wai-off");
	const before = models.requests.length;

	await expect(talk(off, started)).rejects.toThrow(
		"This server does not offer Workers AI, so Scout cannot answer. Whoever runs this server can turn it on; see the README.",
	);
	expect(models.requests.length).toBe(before);

	const cookie = started.owner.headers.cookie;
	const chat = await page(off, `/wai-off/chat/${started.conversation.id}`, cookie);
	expect(chat).toContain("This server does not offer Workers AI, so Scout cannot answer yet.");
	expect(chat).not.toContain("Add one in Settings");
	expect(await page(off, "/wai-off/chat", cookie)).toContain("not on this server");
	const agentPage = await page(off, `/wai-off/agents/${started.agent.id}`, cookie);
	expect(agentPage).toContain(
		"This server does not offer Workers AI, so this agent cannot run yet.",
	);
	expect(agentPage).toContain("Whoever runs the server can turn it on.");
});

it("shows Settings > Models that the server offers Workers AI, with models that call tools", async () => {
	const { headers: ada } = await signUp(on, origin, "ada-wai-settings");
	await createWorkspace(on, origin, ada, "wai-settings");

	const html = await page(on, "/wai-settings/settings/models", ada.cookie);
	expect(html).toContain("This server offers Workers AI models to every workspace");
	expect(html).toContain("2 models that can use tools");
	expect(html).toContain(SCOUT);
	expect(html).toContain("@cf/openai/gpt-oss-20b");
	// A model that cannot call tools is no use to an agent.
	expect(html).not.toContain(NO_TOOLS);
	// Keys are for the providers that have them: no row, button or form for Workers AI.
	expect(html).toContain("Anthropic");
	expect(html.match(/Add key/g)).toHaveLength(3);
	expect(html).not.toContain("Workers AI key");
	expect(html).not.toContain(TOKEN);

	// Listing the models is the deployment's call, made with its token.
	const search = models.requests.findLast((seen) => seen.url === SEARCH);
	expect(search?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
});

it("shows Settings > Models that the server does not offer Workers AI without its token", async () => {
	const { headers: ada } = await signUp(off, origin, "ada-wai-bare");
	await createWorkspace(off, origin, ada, "wai-bare");
	const before = models.requests.length;

	const html = await page(off, "/wai-bare/settings/models", ada.cookie);
	expect(html).toContain("This server does not offer Workers AI.");
	expect(html).toContain("WORKERS_AI_TOKEN");
	expect(html).not.toContain("models that can use tools");
	expect(models.requests.length).toBe(before);
});

it("is not offered with a token but no account to charge", async () => {
	const half = await startAgents(origin, { models, settings: { WORKERS_AI_TOKEN: TOKEN } });
	try {
		const { headers: ada } = await signUp(half, origin, "ada-wai-half");
		await createWorkspace(half, origin, ada, "wai-half");
		const html = await page(half, "/wai-half/settings/models", ada.cookie);
		expect(html).toContain("This server does not offer Workers AI.");
		expect(html).not.toContain(TOKEN);
	} finally {
		await half.dispose();
	}
});

it("takes the account from the AI Gateway address when none is named", async () => {
	const gateway = await startAgents(origin, {
		models,
		settings: {
			WORKERS_AI_TOKEN: TOKEN,
			AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/gateweave`,
		},
	});
	try {
		const { headers: ada } = await signUp(gateway, origin, "ada-wai-gw");
		await createWorkspace(gateway, origin, ada, "wai-gw");
		const html = await page(gateway, "/wai-gw/settings/models", ada.cookie);
		expect(html).toContain("This server offers Workers AI models to every workspace");
	} finally {
		await gateway.dispose();
	}
});

it("says when Cloudflare refuses the server's token, without repeating it", async () => {
	const wrong = await startAgents(origin, {
		models,
		settings: { WORKERS_AI_TOKEN: "revoked-token-long-ago", CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
	});
	try {
		const { headers: ada } = await signUp(wrong, origin, "ada-wai-wrong");
		await createWorkspace(wrong, origin, ada, "wai-wrong");
		const html = await page(wrong, "/wai-wrong/settings/models", ada.cookie);
		expect(html).toContain("Workers AI refused this server&#x27;s token");
		expect(html).not.toContain("revoked-token");
	} finally {
		await wrong.dispose();
	}
});
