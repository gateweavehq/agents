import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import { CLAUDE_CODE_PLACEHOLDER_KEY, linesOf } from "../src/claude-code";
import { anthropicRequest } from "../src/models";
import { decideOutbound } from "../src/outbound";
import type { FakeSandbox } from "./fake-sandbox";
import { ask, connect, KEY } from "./support";

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

/** A conversation with an agent whose engine is Claude Code, with a repository or not. */
async function conversation({ repository = false }: { repository?: boolean } = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = null] = repository ? await registry.syncRepositories([SITE]) : [];
	const rules = await registry.createLibraryAsset({
		kind: "instructions",
		name: "rules",
		text: "Be brief.\n",
	});
	const agent = await registry.createAgent({
		name: "Builder",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: rules, version: 1 },
		sandbox: true,
		engine: "claude-code",
		repositoryId,
	});
	const conversationId = (await registry.startConversation(agent.id, "user-ada"))?.id ?? "";
	const name = conversationName(workspaceId, conversationId);
	const stub = await getAgentByName(env.CONVERSATIONS, name);
	const machine = (env.SANDBOX as unknown as DurableObjectNamespace<FakeSandbox>).getByName(name);
	return { workspaceId, registry, stub, machine, conversationId, agentId: agent.id };
}

/** One content block of a reply, as Claude Code sends it: with the reply's id and usage so far. */
function assistant(
	id: string,
	content: object,
	usage: object,
	extra: { parent_tool_use_id?: string; error?: string; model?: string } = {},
): string {
	return JSON.stringify({
		type: "assistant",
		message: {
			id,
			type: "message",
			role: "assistant",
			model: extra.model ?? "claude-sonnet-5-5",
			content: [content],
			stop_reason: null,
			usage,
		},
		parent_tool_use_id: extra.parent_tool_use_id ?? null,
		...(extra.error ? { error: extra.error } : {}),
		uuid: crypto.randomUUID(),
		session_id: "session",
	});
}

function toolResult(toolUseId: string, content: string, isError = false): string {
	return JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
		},
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "session",
	});
}

function result(fields: object = {}): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		num_turns: 2,
		result: "There are two files.",
		total_cost_usd: 0.01,
		session_id: "session",
		...fields,
	});
}

const INIT = JSON.stringify({
	type: "system",
	subtype: "init",
	session_id: "session",
	model: "claude-sonnet-5-5",
	tools: ["Bash", "Read"],
});

/** A turn that lists the files with Bash, then answers: two model requests. */
const LISTING = [
	INIT,
	assistant(
		"msg_1",
		{ type: "text", text: "Let me look. " },
		{ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000 },
	),
	assistant(
		"msg_1",
		{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
		{ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 },
	),
	toolResult("toolu_1", "a.txt\nb.txt"),
	assistant(
		"msg_2",
		{ type: "text", text: "There are two files." },
		{ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 1100 },
	),
	result(),
];

describe("an agent whose engine is Claude Code", () => {
	it("runs Claude Code in its sandbox, and passes on its text, tool calls and usage", async () => {
		const { workspaceId, registry, stub, machine, conversationId, agentId } = await conversation({
			repository: true,
		});
		await machine.scriptClaudeCode({ lines: LISTING });
		const socket = await connect(stub);
		const turn = await ask(socket, "List the files");
		socket.close();

		expect(turn).toMatchObject({ text: "Let me look. There are two files.", error: null });
		// Its tool calls reach the chat under Claude Code's name.
		expect(turn.raw.join("\n")).toContain("claude-code__Bash");
		const branch = `gateweave/${conversationId}`;
		const seen = await machine.seen();
		// The repository is checked out first, and Claude Code works in it.
		expect(seen.checkouts).toMatchObject([{ branch }]);
		expect(seen.claudeCode).toMatchObject([
			{
				prompt: "List the files",
				history: null,
				model: "claude-sonnet-5-5",
				cwd: "/workspace/repo",
				access: {
					key: KEY,
					metadata: { workspace: workspaceId, agent: agentId, conversation: conversationId },
				},
			},
		]);
		// The agent's instructions come first, then where it runs.
		const system = seen.claudeCode[0]?.system ?? "";
		expect(system).toContain("Be brief.");
		expect(system).toContain(
			`acme/site is checked out at /workspace/repo, on the branch ${branch}`,
		);
		expect(system.indexOf("Be brief.")).toBeLessThan(system.indexOf("acme/site"));

		const [run] = await registry.listRuns();
		// Cached input counts in the input, as Gateweave's own runs count it.
		expect(run).toMatchObject({
			status: "succeeded",
			steps: 2,
			inputTokens: 1100 + 1150,
			outputTokens: 30,
			cachedInputTokens: 2100,
			cost: 500 + 310,
		});
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "model")).toMatchObject([
			{ step: 0, status: "ok", finishReason: "tool-calls" },
			{ step: 1, status: "ok", finishReason: "stop" },
		]);
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ step: 0, status: "ok", server: "claude-code", tool: "Bash", error: null },
		]);
	});

	it("works at the sandbox's root when the agent has no repository", async () => {
		const { stub, machine } = await conversation();
		await machine.scriptClaudeCode({ lines: LISTING });
		const socket = await connect(stub);
		await ask(socket, "List the files");
		socket.close();

		const seen = await machine.seen();
		expect(seen.checkouts).toEqual([]);
		expect(seen.claudeCode).toMatchObject([{ cwd: "/workspace" }]);
		expect(seen.claudeCode[0]?.system).toContain("reaches no website");
	});

	it("hands a later turn the conversation so far, for a sandbox that lost its session", async () => {
		const { stub, machine } = await conversation();
		await machine.scriptClaudeCode({ lines: LISTING });
		await machine.scriptClaudeCode({ lines: LISTING });
		const socket = await connect(stub);
		await ask(socket, "List the files");
		await ask(socket, "And the folders?");
		socket.close();

		const [, second] = (await machine.seen()).claudeCode;
		expect(second?.prompt).toBe("And the folders?");
		expect(second?.history).toContain("The person: List the files");
		expect(second?.history).toContain("Builder: Let me look.");
		expect(second?.history).toContain("There are two files.");
	});

	it("records a subagent's work in the trace, not in the chat", async () => {
		const { registry, stub, machine } = await conversation();
		const usage = { input_tokens: 10, output_tokens: 1 };
		await machine.scriptClaudeCode({
			lines: [
				assistant(
					"msg_1",
					{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { prompt: "look" } },
					usage,
				),
				assistant("msg_sub", { type: "text", text: "a subagent's thought" }, usage, {
					parent_tool_use_id: "toolu_agent",
				}),
				toolResult("toolu_agent", "found it"),
				assistant("msg_2", { type: "text", text: "Done." }, usage),
				result(),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Look around");
		socket.close();

		expect(turn).toMatchObject({ text: "Done.", error: null });
		expect(turn.raw.join("\n")).not.toContain("a subagent's thought");
		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "succeeded", steps: 3 });
	});

	it("fails the turn in the app's words when Anthropic refuses the key", async () => {
		const { registry, stub, machine } = await conversation();
		const refusal =
			"Anthropic refused the workspace's key. An owner or admin can check it in Settings.";
		// What Claude Code 2.1.308 sends on staging when Anthropic answers 401.
		const terminalWords = "Invalid API key · Fix external API key";
		await machine.scriptClaudeCode({
			lines: [
				INIT,
				assistant(
					"msg_1",
					{ type: "text", text: terminalWords },
					{ input_tokens: 0, output_tokens: 0 },
					{ error: "authentication_failed", model: "<synthetic>" },
				),
				result({ is_error: true, result: terminalWords }),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe(refusal);
		// Claude Code's message for a terminal is neither the chat's answer nor a model request.
		expect(turn.text).toBe("");
		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "failed", error: refusal, steps: 0 });
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "model")).toEqual([]);
	});

	it("quotes Claude Code when it fails for a reason the app has no words for", async () => {
		const { stub, machine } = await conversation();
		await machine.scriptClaudeCode({
			lines: [
				INIT,
				assistant(
					"msg_1",
					{ type: "text", text: "API Error: 400 prompt is too long" },
					{ input_tokens: 0, output_tokens: 0 },
					{ error: "invalid_request", model: "<synthetic>" },
				),
				result({ is_error: true, result: "API Error: 400 prompt is too long" }),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe("Claude Code could not finish: API Error: 400 prompt is too long");
	});

	it("fails the turn when Claude Code stops without a result", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptClaudeCode({ lines: [INIT] });
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe("Claude Code stopped before it finished.");
		expect((await registry.listRuns())[0]).toMatchObject({ status: "failed" });
	});

	it("says how many turns it took when it ran out of them", async () => {
		const { stub, machine } = await conversation();
		await machine.scriptClaudeCode({
			lines: [INIT, result({ subtype: "error_max_turns", is_error: true, num_turns: 100 })],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe("Claude Code stopped after 100 turns, the most one message may take.");
	});

	it("stops Claude Code when the turn is stopped", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptClaudeCode({
			lines: [
				INIT,
				assistant("msg_1", { type: "text", text: "Working on it." }, { input_tokens: 1 }),
			],
			untilStopped: true,
		});
		const socket = await connect(stub);
		const id = crypto.randomUUID();
		const turn = ask(socket, "Take your time", id);
		await vi.waitFor(async () => expect((await machine.seen()).claudeCode).toHaveLength(1));
		socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id }));
		await turn;
		socket.close();

		await vi.waitFor(async () => expect((await registry.listRuns())[0]?.status).toBe("stopped"));
		expect((await machine.seen()).stops).toBe(1);
	});
});

describe("Anthropic from the sandbox", () => {
	const messages = new URL("https://api.anthropic.com/v1/messages");

	it("is reachable only while Claude Code runs a turn, and only for the model", () => {
		expect(decideOutbound("POST", messages)).toMatchObject({ allow: false });
		expect(decideOutbound("POST", messages, null, true)).toEqual({
			allow: true,
			credentials: "anthropic",
		});
		const tokens = new URL("https://api.anthropic.com/v1/messages/count_tokens");
		expect(decideOutbound("POST", tokens, null, true)).toMatchObject({ allow: true });
		expect(decideOutbound("GET", messages, null, true)).toMatchObject({ allow: false });
		const files = new URL("https://api.anthropic.com/v1/files");
		expect(decideOutbound("POST", files, null, true)).toMatchObject({ allow: false });
	});

	it("gets the workspace's key in place of the placeholder", async () => {
		const request = new Request(messages, {
			method: "POST",
			headers: { "x-api-key": CLAUDE_CODE_PLACEHOLDER_KEY, authorization: "Bearer stray" },
			body: '{"model":"claude-sonnet-5-5"}',
		});
		const metadata = { workspace: "w", agent: "a", conversation: "c" };
		const out = anthropicRequest(request, KEY, {}, metadata);
		expect(out.url).toBe("https://api.anthropic.com/v1/messages");
		expect(out.headers.get("x-api-key")).toBe(KEY);
		expect(out.headers.has("authorization")).toBe(false);
		expect(await out.text()).toBe('{"model":"claude-sonnet-5-5"}');
	});

	it("goes through AI Gateway when the deployment names one", () => {
		const gateway = "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/track";
		const request = new Request(`${messages.href}?beta=true`, {
			method: "POST",
			headers: { "x-api-key": CLAUDE_CODE_PLACEHOLDER_KEY },
			body: "{}",
		});
		const metadata = { workspace: "w", agent: "a", conversation: "c" };
		const out = anthropicRequest(
			request,
			KEY,
			{ AI_GATEWAY_URL: gateway, AI_GATEWAY_TOKEN: "gateway-token" },
			metadata,
		);
		expect(out.url).toBe(`${gateway}/anthropic/v1/messages?beta=true`);
		expect(out.headers.get("x-api-key")).toBe(KEY);
		expect(out.headers.get("cf-aig-metadata")).toBe(JSON.stringify(metadata));
		expect(out.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
	});
});

describe("Claude Code's output", () => {
	it("is read line by line, however it is split, leaving out lines too long to keep", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of ['{"a":', '1}\n\n{"b"', ":2}\n", '{"c":3}']) {
					controller.enqueue(encoder.encode(part));
				}
				controller.close();
			},
		});
		const lines: string[] = [];
		for await (const line of linesOf(stream)) lines.push(line);
		expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
	});
});
