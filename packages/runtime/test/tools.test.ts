// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { env } from "cloudflare:workers";
import { MCP_CHECK_LIMITS, type McpServerInput, mcpCheckResult } from "@gateweave/agents-model";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkMcpServer, conversationName } from "../src";
import { FakeMcpServer } from "./fake-mcp";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const TOKEN = "acme-secret-token-1234";
const QUERY = "the words a person typed";
const FOUND = "what the tool found for them";

afterEach(() => {
	vi.restoreAllMocks();
});

const ACME: McpServerInput = {
	name: "acme",
	transport: "http",
	url: "https://mcp.acme.dev/mcp",
	headers: [{ name: "Authorization", value: "Bearer ${ACME_TOKEN}" }],
};

const SEARCH = {
	name: "search",
	description: "Searches the tracker",
	inputSchema: {
		type: "object" as const,
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};

/** A conversation with an agent that pins `servers`, and an environment set with the token. */
async function conversation(servers: McpServerInput[], allowed: Record<string, string[]> = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const prod = await registry.createEnvSet({
		name: "prod",
		variables: {},
		secrets: ["ACME_TOKEN", "DOCS_TOKEN"],
	});
	await registry.setEnvSecret({ assetId: prod, name: "ACME_TOKEN", value: TOKEN }, "Ada");
	const pins = [];
	for (const server of servers) {
		pins.push({
			assetId: await registry.createMcpServer(server),
			version: 1,
			tools: allowed[server.name] ?? null,
		});
	}
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: null,
		environment: { assetId: prod, version: 1 },
		mcpServers: pins,
	});
	const started = await registry.startConversation(agent.id, "user-ada");
	const stub = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, started?.id ?? ""),
	);
	return { registry, stub };
}

describe("MCP servers", () => {
	it("give the agent their tools, and each call joins the trace without its content", async () => {
		const acme = new FakeMcpServer([SEARCH], () => ({ content: [{ type: "text", text: FOUND }] }));
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("acme__search", { query: QUERY })
					: anthropicStream("Three issues match."),
			{ "mcp.acme.dev": acme.handle },
		);
		const { registry, stub } = await conversation([ACME]);
		const socket = await connect(stub);
		const turn = await ask(socket, "Which issues are flaky?");
		socket.close();

		expect(turn).toMatchObject({ text: "Three issues match.", error: null });
		// The server got the agent's token, from its environment set.
		expect(acme.requests.map((request) => request.method)).toEqual(
			expect.arrayContaining(["initialize", "tools/list", "tools/call"]),
		);
		for (const request of acme.requests) {
			expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		}
		// The model saw the tool under the server's name, and then what it found.
		expect(requests[0]?.body.tools).toMatchObject([{ name: "acme__search" }]);
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(FOUND);

		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "succeeded", steps: 2, inputTokens: 30 });
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace).toMatchObject([
			{ kind: "connect", step: 0, status: "ok", server: "acme", tools: 1, error: null },
			{ kind: "model", step: 0, status: "ok", finishReason: "tool-calls" },
			{
				kind: "tool",
				step: 0,
				status: "ok",
				server: "acme",
				tool: "search",
				inputBytes: JSON.stringify({ query: QUERY }).length,
				outputBytes: expect.any(Number),
				error: null,
			},
			{ kind: "model", step: 1, status: "ok", finishReason: "stop" },
		]);
		const kept = JSON.stringify(trace);
		for (const content of [QUERY, FOUND, TOKEN]) expect(kept).not.toContain(content);
	});

	it("offer only the tools an allowlist names, and skip a listed tool the server lacks", async () => {
		const DELETE = { ...SEARCH, name: "delete_everything", description: "Deletes it all" };
		const READ = { ...SEARCH, name: "read", description: "Reads one" };
		const acme = new FakeMcpServer([SEARCH, DELETE, READ], () => ({ content: [] }));
		const requests = fakeModel(() => anthropicStream("Hello."), { "mcp.acme.dev": acme.handle });
		const { registry, stub } = await conversation([ACME], { acme: ["search", "read", "gone"] });
		const socket = await connect(stub);
		expect(await ask(socket, "Hello")).toMatchObject({ text: "Hello.", error: null });
		socket.close();

		const offered = ((requests[0]?.body.tools ?? []) as { name: string }[]).map(
			(tool) => tool.name,
		);
		expect(offered.sort()).toEqual(["acme__read", "acme__search"]);
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace).toMatchObject([
			{ kind: "connect", status: "ok", server: "acme", tools: 2 },
			{ kind: "model", status: "ok" },
		]);
	});

	it("go on without a server that cannot be reached, and say why in the trace", async () => {
		const refusing = new FakeMcpServer([SEARCH], () => ({ content: [] }));
		fakeModel(() => anthropicStream("Hello."), {
			"mcp.acme.dev": async (request) => {
				await refusing.handle(request);
				return new Response("Bad token", { status: 401 });
			},
		});
		const { registry, stub } = await conversation([
			ACME,
			{
				name: "docs",
				transport: "http",
				url: "https://docs.acme.dev/mcp",
				headers: [{ name: "Authorization", value: "Bearer ${DOCS_TOKEN}" }],
			},
		]);
		const socket = await connect(stub);
		expect(await ask(socket, "Hello")).toMatchObject({ text: "Hello.", error: null });
		socket.close();

		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "succeeded", steps: 1 });
		const trace = await stub.runTrace(run?.id ?? "");
		const connects = trace.filter((span) => span.kind === "connect");
		expect(connects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					server: "acme",
					status: "error",
					tools: null,
					error:
						"It refused the agent's credentials (HTTP 401). Check the values its headers take from the environment set",
				}),
				expect.objectContaining({
					server: "docs",
					status: "error",
					error: "DOCS_TOKEN has no value in the agent's environment set",
				}),
			]),
		);
		expect(connects).toHaveLength(2);
		expect(JSON.stringify(trace)).not.toContain("Bad token");
	});

	it("follow no redirect, so the agent's headers stay with the server", async () => {
		const redirects: string[] = [];
		fakeModel(() => anthropicStream("Hello."), {
			"mcp.acme.dev": async (request) => {
				redirects.push(request.redirect);
				return new Response(null, { status: 302, headers: { location: "https://elsewhere.dev/" } });
			},
			"elsewhere.dev": async () => {
				throw new Error("The redirect was followed");
			},
		});
		const { registry, stub } = await conversation([ACME]);
		const socket = await connect(stub);
		expect(await ask(socket, "Hello")).toMatchObject({ text: "Hello." });
		socket.close();

		// Workers follow redirects unless told not to.
		expect(redirects.length).toBeGreaterThan(0);
		expect(new Set(redirects)).toEqual(new Set(["manual"]));
		const [run] = await registry.listRuns();
		expect(await stub.runTrace(run?.id ?? "")).toMatchObject([
			{
				kind: "connect",
				status: "error",
				error: "It sends the agent to another address, which agents do not follow (HTTP 302)",
			},
			{ kind: "model", status: "ok" },
		]);
	});

	it("record a tool's own error, and let the model answer it", async () => {
		const acme = new FakeMcpServer([SEARCH], () => ({
			content: [{ type: "text", text: "The tracker is down" }],
			isError: true,
		}));
		const requests = fakeModel(
			(call) =>
				call === 0
					? anthropicToolCall("acme__search", { query: QUERY })
					: anthropicStream("The tracker is down."),
			{ "mcp.acme.dev": acme.handle },
		);
		const { registry, stub } = await conversation([ACME]);
		const socket = await connect(stub);
		expect(await ask(socket, "Which issues are flaky?")).toMatchObject({
			text: "The tracker is down.",
		});
		socket.close();

		expect(requests).toHaveLength(2);
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.find((span) => span.kind === "tool")).toMatchObject({
			status: "error",
			error: "The tool answered with an error",
			outputBytes: expect.any(Number),
		});
	});
});

describe("checkMcpServer", () => {
	const server = {
		name: "acme",
		transport: "http" as const,
		url: "https://mcp.acme.dev/mcp",
		headers: { Authorization: `Bearer ${TOKEN}` },
		tools: null,
	};

	it("lists the server's tools with their descriptions, and sends its headers", async () => {
		const acme = new FakeMcpServer([SEARCH, { ...SEARCH, name: "bare", description: "" }], () => ({
			content: [],
		}));
		fakeModel(() => anthropicStream("unused"), { "mcp.acme.dev": acme.handle });

		const result = await checkMcpServer(server);

		expect(result).toEqual({
			ok: true,
			tools: [
				{ name: "search", description: "Searches the tracker" },
				{ name: "bare", description: "" },
			],
		});
		expect(acme.requests.length).toBeGreaterThan(0);
		for (const request of acme.requests) {
			expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		}
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("cuts long descriptions and long lists short", async () => {
		const tools = Array.from({ length: MCP_CHECK_LIMITS.tools + 5 }, (_, index) => ({
			...SEARCH,
			name: `tool-${index}`,
			description: "x".repeat(MCP_CHECK_LIMITS.description + 100),
		}));
		fakeModel(() => anthropicStream("unused"), {
			"mcp.acme.dev": new FakeMcpServer(tools, () => ({ content: [] })).handle,
		});

		const result = await checkMcpServer(server);

		expect(result.ok && result.tools).toHaveLength(MCP_CHECK_LIMITS.tools);
		expect(result.ok && result.tools[0]?.description).toHaveLength(MCP_CHECK_LIMITS.description);
		expect(mcpCheckResult.safeParse(result).success).toBe(true);
	});

	it("says in its own words why a server refused, never what the server said", async () => {
		fakeModel(() => anthropicStream("unused"), {
			"mcp.acme.dev": async () => new Response(`Bad token ${TOKEN}`, { status: 401 }),
		});

		const result = await checkMcpServer(server);

		expect(result).toEqual({
			ok: false,
			error:
				"It refused the agent's credentials (HTTP 401). Check the values its headers take from the environment set",
		});
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(JSON.stringify(result)).not.toContain("Bad token");
	});

	it("follows no redirect, so the headers stay with the server", async () => {
		fakeModel(() => anthropicStream("unused"), {
			"mcp.acme.dev": async () =>
				new Response(null, { status: 302, headers: { location: "https://elsewhere.dev/" } }),
			"elsewhere.dev": async () => {
				throw new Error("The redirect was followed");
			},
		});

		expect(await checkMcpServer(server)).toEqual({
			ok: false,
			error: "It sends the agent to another address, which agents do not follow (HTTP 302)",
		});
	});

	it("reports a server that cannot be reached, and one it has no way to call", async () => {
		fakeModel(() => anthropicStream("unused"), {
			"mcp.acme.dev": async () => {
				throw new TypeError(`Failed to connect with ${TOKEN}`);
			},
		});

		const result = await checkMcpServer(server);

		expect(result).toEqual({ ok: false, error: "It could not be reached" });
		expect(
			await checkMcpServer({
				name: "docs",
				problem: "DOCS_TOKEN has no value in the agent's environment set",
			}),
		).toEqual({ ok: false, error: "DOCS_TOKEN has no value in the agent's environment set" });
	});
});
