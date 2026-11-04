// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { commitEnvironment } from "../src/sandbox";
import type { FakeSandbox } from "./fake-sandbox";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const SECRET_TEXT = "what the file says, which the trace must not";

afterEach(() => {
	vi.restoreAllMocks();
});

const SITE = {
	provider: "github" as const,
	externalId: "7",
	installationId: "99",
	owner: "acme",
	name: "site",
	defaultBranch: "main",
	private: true,
};

/**
 * A conversation with an agent that has a sandbox, or not, a repository in it, or not, and the
 * local MCP servers `localServers` names, each a command with its environment.
 */
async function conversation({
	sandbox,
	repository = false,
	installationId = SITE.installationId,
	localServers = {},
}: {
	sandbox: boolean;
	repository?: boolean;
	installationId?: string;
	localServers?: Record<string, object>;
}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = null] = repository
		? await registry.syncRepositories([{ ...SITE, installationId }])
		: [];
	const mcpServers = await libraryServers(registry, localServers);
	const environment =
		mcpServers.length > 0
			? {
					assetId: await registry.createEnvSet({
						name: "prod",
						variables: { GREETING: "Ahoy" },
						secrets: [],
					}),
					version: 1,
				}
			: null;
	const agent = await registry.createAgent({
		name: "Builder",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: await rules(registry), version: 1 },
		sandbox,
		repositoryId,
		mcpServers,
		environment,
	});
	const conversationId = (await registry.startConversation(agent.id, "user-ada"))?.id ?? "";
	const name = conversationName(workspaceId, conversationId);
	const stub = await getAgentByName(env.CONVERSATIONS, name);
	const machine = (env.SANDBOX as unknown as DurableObjectNamespace<FakeSandbox>).getByName(name);
	return { registry, stub, machine, conversationId };
}

/**
 * GitHub for the pull request tests, which records each request. The app's bot account is read
 * from `/app` and `/users/...`; `botLookup: "down"` fails the first of those, as GitHub might.
 */
function pullRequestGitHub(
	github: { route: string; body: unknown }[],
	botLookup: "up" | "down" = "up",
) {
	return async (request: Request) => {
		const url = new URL(request.url);
		const text = await request.text();
		github.push({
			route: `${request.method} ${url.pathname}${url.search}`,
			body: text === "" ? null : JSON.parse(text),
		});
		if (url.pathname === "/app") {
			return botLookup === "up"
				? Response.json({ slug: "gateweave-agents" })
				: Response.json({ message: "Service Unavailable" }, { status: 503 });
		}
		if (url.pathname.startsWith("/users/")) {
			return Response.json({ id: 141_234, login: "gateweave-agents[bot]" });
		}
		if (url.pathname.endsWith("/access_tokens")) {
			const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
			return Response.json({ token: "ghs_pulls", expires_at: expiresAt }, { status: 201 });
		}
		if (request.headers.get("authorization") !== "Bearer ghs_pulls") {
			return Response.json({ message: "Bad credentials" }, { status: 401 });
		}
		if (request.method === "GET") return Response.json([]);
		return Response.json(
			{
				number: 12,
				html_url: "https://github.com/acme/site/pull/12",
				state: "open",
				merged_at: null,
				head: { sha: "1".repeat(40) },
			},
			{ status: 201 },
		);
	};
}

/** Local MCP servers in the library, as a scan of a repository's `.mcp.json` stores them. */
async function libraryServers(
	registry: ReturnType<typeof env.REGISTRY.getByName>,
	servers: Record<string, object>,
) {
	const names = Object.keys(servers);
	if (names.length === 0) return [];
	const [repository = ""] = await registry.syncRepositories([
		{ ...SITE, externalId: "8", name: "tools" },
	]);
	await registry.applyScan(repository, {
		commit: "a".repeat(40),
		scannedAt: 1_000,
		agents: [],
		assets: names.map((name) => ({
			kind: "mcp-server" as const,
			key: `.mcp.json#${name}`,
			name,
			description: null,
			path: ".mcp.json",
			files: [{ path: ".mcp.json", content: `${JSON.stringify(servers[name])}\n` }],
			metadata: {},
		})),
		problems: [],
		files: [],
	});
	const found = (await registry.getRepository(repository))?.assets ?? [];
	const pins = [];
	for (const asset of found) {
		const assetId = await registry.addToLibrary(asset.id, { name: asset.name });
		pins.push({ assetId, version: 1, tools: null });
	}
	return pins;
}

/** Instructions of the agent's, which the model reads before anything about a repository. */
function rules(registry: ReturnType<typeof env.REGISTRY.getByName>) {
	return registry.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief.\n" });
}

describe("a conversation with a sandbox", () => {
	it("gives the agent tools that work on its own machine, traced without their content", async () => {
		const requests = fakeModel((call) => {
			if (call === 0)
				return anthropicToolCall("write_file", { path: "a.txt", content: SECRET_TEXT });
			if (call === 1) return anthropicToolCall("run_command", { command: "wc -c a.txt" });
			return anthropicStream("The file is written.");
		});
		const { registry, stub, machine } = await conversation({ sandbox: true });
		const socket = await connect(stub);
		const turn = await ask(socket, "Write a.txt, then count it");
		socket.close();

		expect(turn).toMatchObject({ text: "The file is written.", error: null });
		const tools = (requests[0]?.body.tools ?? []) as { name: string }[];
		const names = tools.map((tool) => tool.name);
		expect(names.sort()).toEqual([
			"edit_file",
			"find_files",
			"read_file",
			"run_command",
			"search",
			"write_file",
		]);
		// The sandbox is the conversation's own, under its name.
		expect(await machine.seen()).toMatchObject({
			files: { "/workspace/a.txt": SECRET_TEXT },
			commands: [{ command: "wc -c a.txt", cwd: "/workspace", timeoutSeconds: 120 }],
		});
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(
			`Wrote ${SECRET_TEXT.length} bytes to /workspace/a.txt.`,
		);
		expect(JSON.stringify(requests[2]?.body.messages)).toContain("ran: wc -c a.txt");

		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "succeeded", steps: 3 });
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ step: 0, status: "ok", server: "sandbox", tool: "write_file", error: null },
			{ step: 1, status: "ok", server: "sandbox", tool: "run_command", error: null },
		]);
		expect(JSON.stringify(trace)).not.toContain(SECRET_TEXT);
	});

	it("starts the agent's local MCP servers in it, with its variables, and stops them after", async () => {
		const requests = fakeModel((call) =>
			call === 0
				? anthropicToolCall("echo__echo", { text: SECRET_TEXT })
				: anthropicStream("It echoed."),
		);
		const { registry, stub, machine } = await conversation({
			sandbox: true,
			localServers: {
				echo: { command: "npx", args: ["-y", "@acme/echo-mcp"], env: { GREETING: "${GREETING}" } },
				broken: { command: "missing" },
			},
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Echo it");
		socket.close();

		expect(turn).toMatchObject({ text: "It echoed.", error: null });
		const names = ((requests[0]?.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
		expect(names).toContain("echo__echo");
		expect(names.some((name) => name.startsWith("broken__"))).toBe(false);
		// It answered with the variable from the agent's environment set.
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(`Ahoy: ${SECRET_TEXT}`);

		const { mcpServers } = await machine.seen();
		expect(mcpServers).toEqual(
			expect.arrayContaining([
				{
					command: { command: "npx", args: ["-y", "@acme/echo-mcp"], env: { GREETING: "Ahoy" } },
					heard: expect.arrayContaining(["initialize", "tools/list", "tools/call"]),
					// The turn closed it, so it exited.
					exited: true,
				},
				{ command: { command: "missing", args: [], env: {} }, heard: [], exited: true },
			]),
		);

		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "connect")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ server: "echo", status: "ok", tools: 1 }),
				expect.objectContaining({
					server: "broken",
					status: "error",
					error:
						"Its command did not start, or ended before it answered. Check the command and its arguments",
				}),
			]),
		);
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ status: "ok", server: "echo", tool: "echo", error: null },
		]);
		expect(JSON.stringify(trace)).not.toContain(SECRET_TEXT);
	});

	it("checks out the agent's repository on a branch of the conversation's own, and says so", async () => {
		const requests = fakeModel((call) =>
			call === 0
				? anthropicToolCall("run_command", { command: "git log -1", cwd: "repo" })
				: anthropicStream("It builds."),
		);
		const { stub, machine, conversationId } = await conversation({
			sandbox: true,
			repository: true,
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Does it build?");
		socket.close();

		expect(turn).toMatchObject({ text: "It builds.", error: null });
		const branch = `gateweave/${conversationId}`;
		expect(await machine.seen()).toMatchObject({
			checkouts: [
				{
					repository: {
						owner: "acme",
						name: "site",
						externalId: "7",
						installationId: "99",
						defaultBranch: "main",
					},
					branch,
				},
			],
			commands: [{ command: "git log -1", cwd: "/workspace/repo" }],
		});
		// The agent's instructions come first, then where the repository is.
		const system = JSON.stringify(requests[0]?.body.system);
		expect(system).toContain("Be brief.");
		expect(system).toContain(`acme/site at /workspace/repo, on the branch ${branch}`);
		expect(system.indexOf("Be brief.")).toBeLessThan(system.indexOf("acme/site"));
	});

	it("opens a pull request from the conversation's branch, and puts it on the run", async () => {
		const github: { route: string; body: unknown }[] = [];
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("open_pull_request", {
							title: "Fix the cart",
							body: "It ignored codes.",
						})
					: anthropicStream("It is up for review."),
			{
				"api.github.com": pullRequestGitHub(github),
			},
		);
		const { registry, stub, machine, conversationId } = await conversation({
			sandbox: true,
			repository: true,
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Fix the cart and propose it");
		socket.close();

		expect(turn).toMatchObject({ text: "It is up for review.", error: null });
		const branch = `gateweave/${conversationId}`;
		const names = ((requests[0]?.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
		expect(names).toContain("open_pull_request");
		expect(JSON.stringify(requests[0]?.body.system)).toContain(
			"open_pull_request proposes it as a pull request",
		);
		// The sandbox commits as the app's bot, which GitHub links to the commit, and pushes; the
		// Worker opens the pull request with its own token.
		expect(await machine.seen()).toMatchObject({
			pushes: [
				{
					branch,
					message: "Fix the cart",
					author: {
						name: "Builder",
						email: "141234+gateweave-agents[bot]@users.noreply.github.com",
					},
				},
			],
		});
		expect(github).toEqual([
			{ route: "GET /app", body: null },
			{ route: "POST /app/installations/99/access_tokens", body: null },
			{ route: "GET /users/gateweave-agents%5Bbot%5D", body: null },
			{
				route: "POST /app/installations/99/access_tokens",
				body: {
					repository_ids: [7],
					permissions: { contents: "read", pull_requests: "write" },
				},
			},
			{
				route: `GET /repos/acme/site/pulls?head=acme%3Agateweave%2F${conversationId}&state=open&per_page=1`,
				body: null,
			},
			{
				route: "POST /repos/acme/site/pulls",
				body: { title: "Fix the cart", body: "It ignored codes.", head: branch, base: "main" },
			},
		]);
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(
			"https://github.com/acme/site/pull/12",
		);

		const [run] = await registry.listRuns();
		expect(run?.pullRequest).toEqual({
			repository: "acme/site",
			number: 12,
			url: "https://github.com/acme/site/pull/12",
		});
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ status: "ok", server: "sandbox", tool: "open_pull_request", error: null },
		]);
	});

	it("commits as the agent's own address when the app's bot cannot be read, and still opens the pull request", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const github: { route: string; body: unknown }[] = [];
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("open_pull_request", { title: "Fix the cart", body: "Done." })
					: anthropicStream("It is up for review."),
			{ "api.github.com": pullRequestGitHub(github, "down") },
		);
		// Its own installation, so no bot account it read in another test answers for it.
		const { machine, stub, conversationId } = await conversation({
			sandbox: true,
			repository: true,
			installationId: "98",
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Fix the cart and propose it");
		socket.close();

		expect(turn).toMatchObject({ text: "It is up for review.", error: null });
		expect(requests).toHaveLength(2);
		expect(await machine.seen()).toMatchObject({
			pushes: [
				{
					branch: `gateweave/${conversationId}`,
					author: { name: "Builder", email: "noreply@gateweave.com" },
				},
			],
		});
		expect(github.map((request) => request.route)).toContain("POST /repos/acme/site/pulls");
		expect(error).toHaveBeenCalledWith("A commit's author was not looked up", expect.anything());
	});

	it("goes when the conversation is deleted", async () => {
		const { stub, machine } = await conversation({ sandbox: true });
		await stub.destroy();
		expect(await machine.seen()).toMatchObject({ destroyed: true });
	});
});

describe("a conversation without a sandbox", () => {
	it("gives the agent no sandbox tools, and never reaches one", async () => {
		const requests = fakeModel(() => anthropicStream("Done."));
		const { stub, machine } = await conversation({ sandbox: false });
		const socket = await connect(stub);
		await ask(socket, "Run the tests");
		socket.close();

		expect(requests[0]?.body.tools).toBeUndefined();
		expect(JSON.stringify(requests[0]?.body.system)).not.toContain("/workspace");
		expect(await machine.seen()).toEqual({
			files: {},
			commands: [],
			checkouts: [],
			pushes: [],
			engine: [],
			stops: 0,
			destroyed: false,
			mcpServers: [],
		});
	});
});

describe("commitEnvironment", () => {
	it("makes a commit by its author, and committed by the same one", () => {
		expect(commitEnvironment({ name: "Builder", email: "bot@users.noreply.github.com" })).toEqual({
			GIT_AUTHOR_NAME: "Builder",
			GIT_AUTHOR_EMAIL: "bot@users.noreply.github.com",
			GIT_COMMITTER_NAME: "Builder",
			GIT_COMMITTER_EMAIL: "bot@users.noreply.github.com",
		});
	});
});
