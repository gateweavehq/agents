import type { WikiDetail } from "@gateweave/agents-model";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type RegistryStub, startAgents } from "./agents-worker";
import { FakeGitHub, headOf } from "./fake-github";
import { FakeModels } from "./fake-models";
import { connectAgent } from "./mcp-client";

const origin = "https://agents.test";
const KEY = "sk-ant-wiki-test-key";

const github = new FakeGitHub();
const models = new FakeModels({ [KEY]: { provider: "anthropic", models: ["claude-sonnet-5-5"] } });

const app = {
	id: 7,
	owner: "acme",
	name: "app",
	files: {
		"README.md": "# App\n\nIt keeps a list in sync.\n",
		"src/sync.ts": "export function sync() {\n\treturn fetch('/ops');\n}\n",
		"src/store.ts": "export const store = new Map();\n",
		"logo.png": "not text",
		".devin/wiki.json": JSON.stringify({
			repo_notes: [{ content: "Cite src/ for everything." }],
			pages: [
				{ title: "Overview", purpose: "What the app is" },
				{ title: "Sync", purpose: "How it syncs", parent: "Overview" },
			],
		}),
	},
};

let agents: Awaited<ReturnType<typeof startAgents>>;

/** What the fake Anthropic writes: the plan for a planning request, a page for the rest. */
function anthropicMessage(text: string): Response {
	return Response.json({
		id: "msg_wiki",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-5-5",
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 1200, output_tokens: 300 },
	});
}

beforeAll(async () => {
	github.installations.set("100", {
		account: { login: "acme", type: "Organization" },
		repositories: [app],
	});
	models.script = (body) => {
		const request = body as { stream?: boolean; system?: unknown; messages: unknown[] };
		if (request.stream) return undefined;
		const asked = JSON.stringify(request);
		if (asked.includes("You plan the wiki")) {
			return anthropicMessage(
				JSON.stringify({
					pages: [
						{ title: "Overview", files: ["README.md"] },
						{ title: "Sync", files: ["src/sync.ts", "src/store.ts", "src/gone.ts"] },
					],
				}),
			);
		}
		const page = asked.includes("1.1 Sync  ← this page") ? "sync" : "overview";
		return anthropicMessage(
			page === "sync"
				? "`sync` posts the ops.\n\n**Sources:** [src/sync.ts:1-3](), [src/sync.ts:4]()"
				: "A list kept in sync.\n\n**Sources:** [README.md:3]()",
		);
	};
	agents = await startAgents(origin, { github, models });
});

afterAll(async () => {
	await agents?.dispose();
});

async function repositoryIn(registry: RegistryStub): Promise<string> {
	const [repositoryId = ""] = await registry.syncRepositories([
		{
			provider: "github",
			externalId: String(app.id),
			installationId: "100",
			owner: app.owner,
			name: app.name,
			defaultBranch: "main",
			private: true,
		},
	]);
	return repositoryId;
}

async function settled(registry: RegistryStub, repositoryId: string): Promise<WikiDetail> {
	for (let tries = 0; tries < 150; tries++) {
		const wiki = await registry.getWiki(repositoryId);
		const latest = wiki?.latest;
		if (wiki && (!latest || latest.status === "failed")) return wiki;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("The wiki was not written in time");
}

it("writes a repository's wiki with the workspace's key, as .devin/wiki.json steers it", async () => {
	const { headers: ada, userId } = await signUp(agents, origin, "ada-wiki");
	const id = await createWorkspace(agents, origin, ada, "wiki-acme");
	const registry = await agents.registry(id);
	const repositoryId = await repositoryIn(registry);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, userId);

	const started = await registry.startWiki(
		repositoryId,
		{ provider: "anthropic", model: "claude-sonnet-5-5" },
		userId,
	);
	expect(started).toMatchObject({ generation: expect.any(String) });

	const wiki = await settled(registry, repositoryId);
	expect(wiki.latest).toBeNull();
	expect(wiki.live).toMatchObject({
		status: "ready",
		commit: headOf(app),
		steered: true,
		pagesTotal: 2,
		pagesDone: 2,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		// Three requests of 1,200 tokens in and 300 out, at the model's list prices.
		tokens: { input: 3600, output: 900 },
		cost: expect.any(Number),
	});
	expect(wiki.pages).toEqual([
		{ number: "1", title: "Overview", depth: 0 },
		{ number: "1.1", title: "Sync", depth: 1 },
	]);

	const sync = await registry.getWikiPage(repositoryId, "1.1");
	// The file the plan named that the repository lacks is left out, and so are lines the file
	// does not have.
	expect(sync).toMatchObject({
		title: "Sync",
		purpose: "How it syncs",
		commit: headOf(app),
		sources: [
			{ path: "src/sync.ts", lines: 3 },
			{ path: "src/store.ts", lines: 1 },
		],
		body: "`sync` posts the ops.\n\n**Sources:** [src/sync.ts:1-3](), `src/sync.ts`",
	});

	// The key went to Anthropic alone, and no prompt carried it.
	const sent = models.requests.filter((request) => request.url.endsWith("/v1/messages"));
	expect(sent).toHaveLength(3);
	for (const request of sent) {
		expect(request.headers.get("x-api-key")).toBe(KEY);
		expect(request.body).not.toContain(KEY);
	}
	// The steering file's notes reached the writers.
	expect(sent[1]?.body).toContain("Cite src/ for everything.");
	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
});

it("keeps the wiki people read while another is written, then replaces it", async () => {
	const { headers: ada, userId } = await signUp(agents, origin, "ada-wiki-again");
	const id = await createWorkspace(agents, origin, ada, "wiki-again");
	const registry = await agents.registry(id);
	const repositoryId = await repositoryIn(registry);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, userId);
	const choice = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };

	await registry.startWiki(repositoryId, choice, userId);
	const first = await settled(registry, repositoryId);
	expect(first.live?.status).toBe("ready");
	const again = await registry.startWiki(repositoryId, choice, userId);
	expect(again).toMatchObject({ generation: expect.any(String) });
	// While it is written, people still read the first.
	const meanwhile = await registry.getWiki(repositoryId);
	expect(meanwhile?.live?.id).toBe(first.live?.id);
	expect(meanwhile?.latest?.status).toMatch(/planning|writing/);
	expect(meanwhile?.pages).toHaveLength(2);
	// One at a time.
	expect(await registry.startWiki(repositoryId, choice, userId)).toMatchObject({
		status: "refused",
		message: expect.stringMatching(/being written/),
	});
	const second = await settled(registry, repositoryId);
	expect(second.live?.id).not.toBe(first.live?.id);
	expect(second.pages).toHaveLength(2);
	expect((await registry.listWikis()).map((entry) => entry.live?.id)).toEqual([second.live?.id]);
});

it("refuses to write without a key for the provider", async () => {
	const { headers: ada, userId } = await signUp(agents, origin, "ada-wiki-nokey");
	const id = await createWorkspace(agents, origin, ada, "wiki-nokey");
	const registry = await agents.registry(id);
	const repositoryId = await repositoryIn(registry);
	expect(
		await registry.startWiki(repositoryId, { provider: "openai", model: "gpt-6-sol" }, userId),
	).toMatchObject({ status: "refused", message: expect.stringMatching(/OpenAI/) });
	expect((await registry.getWiki(repositoryId))?.latest).toBeNull();
});

it("fails at once, saying why, when the provider refuses the key", async () => {
	const refusedKey = "sk-ant-refused-key";
	const { headers: ada, userId } = await signUp(agents, origin, "ada-wiki-refused");
	const id = await createWorkspace(agents, origin, ada, "wiki-refused");
	const registry = await agents.registry(id);
	const repositoryId = await repositoryIn(registry);
	await registry.saveProviderKey({ provider: "anthropic", key: refusedKey }, userId);
	await registry.startWiki(
		repositoryId,
		{ provider: "anthropic", model: "claude-sonnet-5-5" },
		userId,
	);

	const wiki = await settled(registry, repositoryId);
	expect(wiki.live).toBeNull();
	expect(wiki.pages).toEqual([]);
	expect(wiki.latest).toMatchObject({
		status: "failed",
		error: "Anthropic refused the workspace's key. An owner or admin can check it in Settings.",
	});
	// Asking again could not change a refusal, so the step asked once.
	const asked = models.requests.filter(
		(request) => request.headers.get("x-api-key") === refusedKey,
	);
	expect(asked).toHaveLength(1);
	expect(JSON.stringify(agents.logs)).not.toContain(refusedKey);
});

it("shows members the wiki's pages, citations linked to the lines at the commit", async () => {
	const { headers: ada, userId } = await signUp(agents, origin, "ada-wiki-page");
	const id = await createWorkspace(agents, origin, ada, "wiki-page");
	const registry = await agents.registry(id);
	const repositoryId = await repositoryIn(registry);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, userId);
	await registry.startWiki(
		repositoryId,
		{ provider: "anthropic", model: "claude-sonnet-5-5" },
		userId,
	);
	expect((await settled(registry, repositoryId)).live?.status).toBe("ready");

	const page = await agents.fetch(`${origin}/wiki-page/wiki/${repositoryId}/1.1`, {
		headers: { cookie: ada.cookie },
	});
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(html).toContain("posts the ops.");
	expect(html).toContain(`https://github.com/acme/app/blob/${headOf(app)}/src/sync.ts#L1-L3`);

	const { headers: eve } = await signUp(agents, origin, "eve-wiki");
	const other = await (
		await agents.fetch(`${origin}/wiki-page/wiki/${repositoryId}/1.1`, {
			headers: { cookie: eve.cookie },
		})
	).text();
	expect(other).not.toContain("posts the ops.");
});

it("lets a member's AI agent read the wiki over MCP with DeepWiki's tools, and no one else's", async () => {
	const { headers: ada, userId } = await signUp(agents, origin, "ada-wiki-mcp");
	const id = await createWorkspace(agents, origin, ada, "wiki-mcp");
	const registry = await agents.registry(id);
	const repositoryId = await repositoryIn(registry);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, userId);
	await registry.startWiki(
		repositoryId,
		{ provider: "anthropic", model: "claude-sonnet-5-5" },
		userId,
	);
	expect((await settled(registry, repositoryId)).live?.status).toBe("ready");

	const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
		(result.content as { text: string }[])[0]?.text ?? "";

	const client = await connectAgent(agents, origin, ada.cookie);
	// DeepWiki's argument alone, in any case, as agents write repository names.
	const structure = await client.callTool({
		name: "read_wiki_structure",
		arguments: { repoName: "ACME/App" },
	});
	expect(textOf(structure)).toBe("Available pages for acme/app:\n\n- 1 Overview\n  - 1.1 Sync");
	const page = await client.callTool({
		name: "read_wiki_contents",
		arguments: { repoName: "acme/app", page: "1.1" },
	});
	expect(textOf(page)).toContain("`sync` posts the ops.");
	expect(textOf(page)).toContain("- [src/sync.ts](src/sync.ts)");

	// A question finds the page that answers it, and asks no model: the caller has its own.
	const asked = models.requests.length;
	const answer = await client.callTool({
		name: "ask_wiki_question",
		arguments: { repoName: "acme/app", question: "What does sync post?" },
	});
	expect(textOf(answer)).toMatch(
		/^From the wiki of acme\/app, the pages that bear on the question/,
	);
	expect(textOf(answer)).toContain("`sync` posts the ops.");
	expect(models.requests.length).toBe(asked);

	const listed = await client.callTool({ name: "list_wiki_repos", arguments: {} });
	expect(textOf(listed)).toMatch(
		/^Repositories with a wiki:\n\n- acme\/app \(workspace wiki-mcp, private\): 2 pages, at commit [0-9a-f]{7}, written \d{4}-\d{2}-\d{2}$/,
	);
	await client.close();

	const { headers: eve } = await signUp(agents, origin, "eve-wiki-mcp");
	const stranger = await connectAgent(agents, origin, eve.cookie);
	for (const args of [{ repoName: "acme/app" }, { repoName: "acme/app", workspace: "wiki-mcp" }]) {
		const refused = await stranger.callTool({ name: "read_wiki_contents", arguments: args });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toBe("Error fetching wiki for acme/app: Repository not found.");
	}
	const theirs = await stranger.callTool({
		name: "ask_wiki_question",
		arguments: { repoName: "acme/app", question: "What does sync post?" },
	});
	expect(textOf(theirs)).toBe("Error fetching wiki for acme/app: Repository not found.");
	const none = await stranger.callTool({ name: "list_wiki_repos", arguments: {} });
	expect(textOf(none)).toMatch(/^No repository in your workspaces has a wiki yet/);
	await stranger.close();
});
