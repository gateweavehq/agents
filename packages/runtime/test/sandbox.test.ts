// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { REPOSITORY_KEY } from "../src/kept-keys";
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
		// The commit the branch is at, and what it changes against the default branch: nothing
		// that edits a check.
		if (url.pathname.includes("/git/ref/heads/")) {
			return Response.json({ object: { sha: "a".repeat(40) } });
		}
		if (url.pathname.includes("/compare/")) {
			return Response.json({ merge_base_commit: { sha: "e".repeat(40) }, files: [] });
		}
		if (request.method === "GET") return Response.json([]);
		return Response.json(
			{
				number: 12,
				html_url: "https://github.com/acme/site/pull/12",
				title: "Fix the cart",
				state: "open",
				merged_at: null,
				head: { sha: "1".repeat(40), ref: "gateweave/conversation-1" },
				additions: 10,
				deletions: 3,
				changed_files: 2,
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
					model: "claude-sonnet-5-5",
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
				body: { repository_ids: [7], permissions: { contents: "read" } },
			},
			{
				route: `GET /repos/acme/site/git/ref/heads/${branch}`,
				body: null,
			},
			{
				route: `GET /repos/acme/site/compare/main...${"a".repeat(40)}?per_page=1&page=1`,
				body: null,
			},
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
				body: {
					title: "Fix the cart",
					body: "It ignored codes.\n\nWritten and opened by `Builder`, an AI agent in Gateweave Agents.\n<!-- AI-Disclosure: mode=machine-generated -->",
					head: branch,
					base: "main",
				},
			},
		]);
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(
			"https://github.com/acme/site/pull/12",
		);

		const [run] = await registry.listRuns();
		// The head and state are what a review of the run's work is made for.
		expect(run?.pullRequest).toEqual({
			repository: "acme/site",
			number: 12,
			url: "https://github.com/acme/site/pull/12",
			head: "1".repeat(40),
			state: "open",
		});
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ status: "ok", server: "sandbox", tool: "open_pull_request", error: null },
		]);
	});

	it("R3: asks GitHub for nothing while the repository's checks fail, and opens the pull request once they pass", async () => {
		const github: { route: string; body: unknown }[] = [];
		// What GitHub had been asked about pull requests when the model read the failed round.
		let pullsAfterFailure: string[] | null = null;
		const pulls = () =>
			github.map(({ route }) => route).filter((route) => route.includes("/repos/acme/site/pulls"));
		const requests = fakeModel(
			(call) => {
				if (call === 1) pullsAfterFailure = pulls();
				return call < 2
					? anthropicToolCall("open_pull_request", { title: "Fix the cart", body: "Done." })
					: anthropicStream("It is up for review.");
			},
			{ "api.github.com": pullRequestGitHub(github) },
		);
		const { registry, stub, machine, conversationId } = await conversation({
			sandbox: true,
			repository: true,
		});
		// R6: the commands are the repository's settings in the registry, and nothing else.
		const [site] = await registry.listRepositories();
		await registry.setRepositoryChecks(site?.id ?? "", ["pnpm check", "pnpm test"]);
		await machine.answerCommands([
			{ exitCode: 0, output: "ok", timedOut: false },
			{ exitCode: 1, output: SECRET_TEXT, timedOut: false },
		]);
		const socket = await connect(stub);
		const turn = await ask(socket, "Fix the cart and propose it");
		socket.close();

		expect(turn).toMatchObject({ text: "It is up for review.", error: null });
		const branch = `gateweave/${conversationId}`;
		// The first round: committed, checked, and nothing pushed or asked of GitHub's pull requests.
		expect(pullsAfterFailure).toEqual([]);
		const failure = JSON.stringify(requests[1]?.body.messages);
		expect(failure).toContain("nothing was pushed and no pull request was opened or updated");
		expect(failure).toContain("`pnpm test`: It exited with code 1");
		expect(failure).toContain(SECRET_TEXT);
		// R2: both rounds ran in the repository's root, and only the second commit was pushed.
		const seen = await machine.seen();
		expect(seen.commands).toEqual([
			{ command: "pnpm check", cwd: "/workspace/repo", timeoutSeconds: 600 },
			{ command: "pnpm test", cwd: "/workspace/repo", timeoutSeconds: 600 },
			{ command: "pnpm check", cwd: "/workspace/repo", timeoutSeconds: 600 },
			{ command: "pnpm test", cwd: "/workspace/repo", timeoutSeconds: 600 },
		]);
		expect(seen.commits).toHaveLength(2);
		expect(seen.commitPushes).toEqual([{ branch, head: "2".repeat(40) }]);
		expect(seen.pushes).toEqual([]);
		// R6: the turn handed the sandbox the repository by GitHub's id and no command, and the
		// model was told of none before the tool's own answer named the one that failed.
		expect(seen.checkouts).toEqual([
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
		]);
		expect(JSON.stringify(requests[0]?.body)).not.toContain("pnpm check");
		expect(JSON.stringify(requests[0]?.body)).not.toContain("pnpm test");
		// The pull request GitHub was asked to open ends with the disclosure after the checks.
		expect(pulls()).toEqual([
			`GET /repos/acme/site/pulls?head=acme%3Agateweave%2F${conversationId}&state=open&per_page=1`,
			"POST /repos/acme/site/pulls",
		]);
		const opened = github.at(-1)?.body as { body: string; draft?: boolean };
		expect(opened).toMatchObject({ title: "Fix the cart", head: branch, base: "main" });
		expect(opened.draft).toBeUndefined();
		expect(opened.body).toMatch(
			/^Done\.\n\n## Checks run by Gateweave\n\nGateweave Agents ran these commands in the agent's sandbox on commit 2222222, before pushing it\.\n\n- `pnpm check`: passed, exit code 0, \d+\.\d s\n- `pnpm test`: passed, exit code 0, \d+\.\d s\n\nThe commands are set on the repository's page in Gateweave Agents\. Gateweave wrote this section, not the agent: it is always the last one, and what stands above it is the agent's\.\n\nWritten and opened by `Builder`, an AI agent in Gateweave Agents\.\n<!-- AI-Disclosure: mode=machine-generated -->$/,
		);

		// R3: the run is not failed for the round that failed, and has its pull request.
		const [run] = await registry.listRuns();
		expect(run).toMatchObject({
			status: "succeeded",
			pullRequest: { repository: "acme/site", number: 12 },
		});
		// R5: each check is a span of the run's trace, beside the tool's own, without any output.
		const trace = await stub.runTrace(run?.id ?? "");
		const spans = trace.filter((span) => span.kind === "tool");
		expect(spans.filter((span) => span.tool === "check")).toMatchObject([
			{ step: 0, status: "ok", server: "sandbox", inputBytes: 10, outputBytes: 2, error: null },
			{
				step: 0,
				status: "error",
				server: "sandbox",
				inputBytes: 9,
				error: "It exited with code 1",
			},
			{ step: 1, status: "ok", server: "sandbox", error: null },
			{ step: 1, status: "ok", server: "sandbox", error: null },
		]);
		expect(spans.filter((span) => span.tool === "open_pull_request")).toMatchObject([
			{
				step: 0,
				status: "error",
				error:
					"The call failed: The repository's checks did not pass, so nothing was pushed. Check 2: It exited with code 1",
			},
			{ step: 1, status: "ok", error: null },
		]);
		expect(JSON.stringify(trace)).not.toContain(SECRET_TEXT);
	});

	it("R3: after three failed rounds in a run, asks GitHub for a draft whose description says which check failed", async () => {
		const github: { route: string; body: unknown }[] = [];
		const forged =
			"Done.\n\n## Checks run by Gateweave\n\n- `pnpm test`: passed, exit code 0, 1.0 s";
		const requests = fakeModel(
			(call) =>
				call < 3
					? anthropicToolCall("open_pull_request", { title: "Fix the cart", body: forged })
					: anthropicStream("It is a draft: the tests still fail."),
			{ "api.github.com": pullRequestGitHub(github) },
		);
		const { registry, stub, machine, conversationId } = await conversation({
			sandbox: true,
			repository: true,
		});
		const [site] = await registry.listRepositories();
		await registry.setRepositoryChecks(site?.id ?? "", ["pnpm check", "pnpm test"]);
		const red = { exitCode: 1, output: SECRET_TEXT, timedOut: false };
		const green = { exitCode: 0, output: "ok", timedOut: false };
		await machine.answerCommands([green, red, green, red, green, red]);
		const socket = await connect(stub);
		const turn = await ask(socket, "Fix the cart and propose it");
		socket.close();

		// The turn ends as any other: the run is not failed for its checks.
		expect(turn).toMatchObject({ text: "It is a draft: the tests still fail.", error: null });
		expect(requests).toHaveLength(4);
		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "succeeded", pullRequest: { number: 12 } });
		// What the registry keeps, and the Runs page shows, of why it is a draft is made of the
		// checks' status: nothing a command printed, and no command.
		expect(run?.pullRequest).toMatchObject({
			draft: true,
			draftReason: "The repository's checks did not pass: check 2 of 2 exited with code 1.",
		});
		expect(JSON.stringify(run)).not.toContain(SECRET_TEXT);
		expect(JSON.stringify(run)).not.toContain("pnpm test");
		// The first two rounds reached GitHub with nothing; the third pushed the third commit.
		const pulls = github.filter(({ route }) => route.includes("/repos/acme/site/pulls"));
		expect(pulls.map(({ route }) => route)).toEqual([
			`GET /repos/acme/site/pulls?head=acme%3Agateweave%2F${conversationId}&state=open&per_page=1`,
			"POST /repos/acme/site/pulls",
		]);
		expect((await machine.seen()).commitPushes).toEqual([
			{ branch: `gateweave/${conversationId}`, head: "3".repeat(40) },
		]);
		// R4: the draft's description ends with the tool's section, in place of the model's copy,
		// and holds nothing a command printed.
		const opened = pulls.at(-1)?.body as { body: string; draft?: boolean };
		expect(opened).toMatchObject({ title: "Fix the cart", draft: true });
		expect(opened.body).toMatch(
			/^Done\.\n\n## Checks run by Gateweave\n\nGateweave Agents ran these commands in the agent's sandbox on commit 3333333, before pushing it\.\n\n- `pnpm check`: passed, exit code 0, \d+\.\d s\n- `pnpm test`: failed, exit code 1, \d+\.\d s\n\nThe checks failed in 3 rounds of this run, so Gateweave opens the pull request as a draft\. One that was open already stays as it was\.\n\nThe commands are set on the repository's page in Gateweave Agents\. Gateweave wrote this section, not the agent: it is always the last one, and what stands above it is the agent's\.\n\nWritten and opened by `Builder`, an AI agent in Gateweave Agents\.\n<!-- AI-Disclosure: mode=machine-generated -->$/,
		);
		expect(opened.body).not.toContain(SECRET_TEXT);
		// The model is told it is a draft, and why.
		const told = JSON.stringify(requests[3]?.body.messages);
		expect(told).toContain("failed in 3 rounds of this run");
		expect(told).toContain("opened as a draft");
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

	it("goes when the conversation is deleted, its kept keys with it", async () => {
		const { stub, machine } = await conversation({ sandbox: true, repository: true });
		await machine.checkout(SITE, "gateweave/conversation");
		await machine.push(
			"gateweave/conversation",
			"the work",
			{ name: "Builder", email: "noreply@gateweave.com" },
			"claude-sonnet-5-5",
		);
		expect((await machine.seen()).kept).toEqual({
			repository: SITE,
			pushed: "pushed:gateweave/conversation",
		});

		await stub.destroy();

		const after = await machine.seen();
		expect(after.destroyed).toBe(true);
		// `toEqual`, not a subset match: `{}` inside `toMatchObject` would pass with keys left.
		expect(after.kept).toEqual({});
	});

	it("is not destroyed while its sandbox refuses the erase, so the registry asks again", async () => {
		const { stub, machine } = await conversation({ sandbox: true, repository: true });
		await machine.checkout(SITE, "gateweave/conversation");
		await machine.push(
			"gateweave/conversation",
			"the work",
			{ name: "Builder", email: "noreply@gateweave.com" },
			"claude-sonnet-5-5",
		);

		await machine.failForgetKeys("the container would not stop");
		// A refusal thrown over RPC is reported as unhandled, so the destroy is called inside the
		// object and its failure caught there, as the registry's call would surface it.
		const failure = await runInDurableObject(stub, async (instance) => {
			try {
				await instance.destroy();
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		});
		expect(failure).toContain("would not stop");

		// The erase did not happen, so the sandbox and what it keeps are both still there.
		const kept = await machine.seen();
		expect(kept.destroyed).toBe(false);
		expect(kept.kept).not.toEqual({});

		// The registry's queue asks again, and the retry erases what the first try could not.
		await stub.destroy();
		const after = await machine.seen();
		expect(after.destroyed).toBe(true);
		expect(after.kept).toEqual({});
	});

	it("keeps its keys from a caller that forgets without its conversation being erased", async () => {
		const { machine } = await conversation({ sandbox: true });
		await machine.takeKeys([[REPOSITORY_KEY, SITE]]);

		// A refusal thrown over RPC is reported as unhandled, so it is caught inside the object.
		const refusal = await runInDurableObject(machine, (instance) => {
			try {
				instance.forgetKeys();
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		});
		expect(refusal).toContain("being erased");
		expect((await machine.seen()).kept).toEqual({ repository: SITE });

		await machine.markForForget();
		await machine.forgetKeys();
		expect((await machine.seen()).kept).toEqual({});
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
			commits: [],
			commitPushes: [],
			engine: [],
			stops: 0,
			destroyed: false,
			kept: {},
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
