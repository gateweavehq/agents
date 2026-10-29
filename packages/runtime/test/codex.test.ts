import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import {
	CODEX_ENV,
	CODEX_PLACEHOLDER_KEY,
	codexArguments,
	codexCommand,
	tomlString,
} from "../src/codex";
import { openaiRequest } from "../src/models";
import { decideOutbound } from "../src/outbound";
import type { FakeSandbox } from "./fake-sandbox";
import { ask, connect, type Turn } from "./support";

afterEach(() => {
	vi.restoreAllMocks();
});

const KEY = "sk-proj-secret-abcdefgh";

const SITE = {
	provider: "github" as const,
	externalId: "7",
	installationId: "99",
	owner: "acme",
	name: "site",
	defaultBranch: "main",
	private: true,
};

/** A conversation with an agent whose engine is Codex, with a repository or not. */
async function conversation({ repository = false }: { repository?: boolean } = {}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "openai", key: KEY }, "Ada");
	const [repositoryId = null] = repository ? await registry.syncRepositories([SITE]) : [];
	const rules = await registry.createLibraryAsset({
		kind: "instructions",
		name: "rules",
		text: "Be brief.\n",
	});
	const agent = await registry.createAgent({
		name: "Builder",
		description: null,
		provider: "openai",
		model: "gpt-5.5",
		instructions: { assetId: rules, version: 1 },
		sandbox: true,
		engine: "codex",
		repositoryId,
	});
	const conversationId = (await registry.startConversation(agent.id, "user-ada"))?.id ?? "";
	const name = conversationName(workspaceId, conversationId);
	const stub = await getAgentByName(env.CONVERSATIONS, name);
	const machine = (env.SANDBOX as unknown as DurableObjectNamespace<FakeSandbox>).getByName(name);
	return { workspaceId, registry, stub, machine, conversationId, agentId: agent.id };
}

/** The chunks of the turn that reached the browser. */
function chunksOf(turn: Turn): unknown[] {
	return turn.raw.flatMap((raw) => {
		const { body } = JSON.parse(raw) as { body?: string };
		return body?.trim() ? [JSON.parse(body)] : [];
	});
}

/** One of Codex's events, as `codex exec --json` writes it. */
function event(type: string, fields: object = {}): string {
	return JSON.stringify({ type, ...fields });
}

/** An item of the thread as it starts or completes. */
function item(
	type: "item.started" | "item.completed",
	fields: { id: string; type: string } & Record<string, unknown>,
) {
	return event(type, { item: fields });
}

/** The thread's usage so far, as `turn.completed` reports it. */
function usage(input: number, cached: number, output: number) {
	return {
		input_tokens: input,
		cached_input_tokens: cached,
		cache_write_input_tokens: 0,
		output_tokens: output,
		reasoning_output_tokens: 0,
	};
}

function command(id: string, status: string, output = "", exitCode: number | null = null) {
	return item(status === "in_progress" ? "item.started" : "item.completed", {
		id,
		type: "command_execution",
		command: "/bin/bash -lc ls",
		aggregated_output: output,
		exit_code: exitCode,
		status,
	});
}

/** A turn of the thread `thread` that answers `text`, with the thread's usage after it. */
function answering(thread: string, text: string, total: ReturnType<typeof usage>): string[] {
	return [
		event("thread.started", { thread_id: thread }),
		event("turn.started"),
		item("item.completed", { id: "item_0", type: "agent_message", text }),
		event("turn.completed", { usage: total }),
	];
}

/** A turn that lists the files, adds one, then answers. */
const LISTING = [
	event("thread.started", { thread_id: "thread-1" }),
	event("turn.started"),
	item("item.completed", { id: "item_0", type: "agent_message", text: "Let me look. " }),
	command("item_1", "in_progress"),
	command("item_1", "completed", "a.txt\nb.txt\n", 0),
	item("item.completed", {
		id: "item_2",
		type: "file_change",
		changes: [{ path: "/workspace/repo/c.txt", kind: "add" }],
		status: "completed",
	}),
	item("item.completed", { id: "item_3", type: "agent_message", text: "There are three files." }),
	event("turn.completed", { usage: usage(1_200, 1_000, 50) }),
];

describe("an agent whose engine is Codex", () => {
	it("runs Codex in its sandbox, and passes on its text, tool calls and usage", async () => {
		const { workspaceId, registry, stub, machine, conversationId, agentId } = await conversation({
			repository: true,
		});
		await machine.scriptEngine({ lines: LISTING });
		const socket = await connect(stub);
		const turn = await ask(socket, "List the files");
		socket.close();

		expect(turn).toMatchObject({ text: "Let me look. There are three files.", error: null });
		const raw = turn.raw.join("\n");
		expect(raw).toContain("codex__shell");
		expect(raw).toContain("codex__apply_patch");
		const seen = await machine.seen();
		expect(seen.checkouts).toMatchObject([{ branch: `gateweave/${conversationId}` }]);
		expect(seen.engine).toMatchObject([
			{
				engine: "codex",
				prompt: "List the files",
				model: "gpt-5.5",
				cwd: "/workspace/repo",
				access: {
					key: KEY,
					metadata: { workspace: workspaceId, agent: agentId, conversation: conversationId },
				},
			},
		]);
		expect(seen.engine[0]?.system).toContain("Be brief.");

		const [run] = await registry.listRuns();
		// One model span for the turn, priced at the standard rates: 200 uncached, 1,000 cached.
		expect(run).toMatchObject({
			status: "succeeded",
			steps: 1,
			inputTokens: 1_200,
			outputTokens: 50,
			cachedInputTokens: 1_000,
			cost: 200 * 5 + 1_000 * 0.5 + 50 * 30,
		});
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "model")).toMatchObject([
			{ step: 0, status: "ok", finishReason: "stop", firstTokenMs: null },
		]);
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ step: 0, status: "ok", server: "codex", tool: "shell", error: null },
			{ step: 0, status: "ok", server: "codex", tool: "apply_patch", error: null },
		]);
	});

	it("counts a resumed thread's turn from where its last turn left it, and a new thread anew", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({ lines: answering("thread-1", "One.", usage(1_200, 1_000, 50)) });
		// Codex reports the thread's usage so far, which the resumed turn carries on from.
		await machine.scriptEngine({ lines: answering("thread-1", "Two.", usage(3_000, 2_500, 120)) });
		// A sandbox that lost the thread starts another, from nothing.
		await machine.scriptEngine({ lines: answering("thread-2", "Three.", usage(500, 0, 10)) });
		const socket = await connect(stub);
		await ask(socket, "One?");
		await ask(socket, "Two?");
		await ask(socket, "Three?");
		socket.close();

		const runs = await registry.listRuns();
		const tokens = runs.map((run) => [run.inputTokens, run.cachedInputTokens, run.outputTokens]);
		expect(tokens.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toEqual([
			[500, 0, 10],
			[1_200, 1_000, 50],
			[1_800, 1_500, 70],
		]);
	});

	it("shows a command that failed as failed, with its exit code", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [
				event("thread.started", { thread_id: "thread-1" }),
				event("turn.started"),
				command("item_1", "in_progress"),
				command("item_1", "failed", "no tests found\n", 1),
				event("turn.completed", { usage: usage(100, 0, 5) }),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Run the tests");
		socket.close();

		expect(chunksOf(turn)).toContainEqual(
			expect.objectContaining({
				type: "tool-output-error",
				toolCallId: "item_1",
				errorText: "Exit code 1\nno tests found\n",
			}),
		);
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ status: "error", tool: "shell", error: "Exit code 1\nno tests found\n" },
		]);
	});

	it("shows Gateweave's tools in the chat under their own names, and leaves their spans to them", async () => {
		const { registry, stub, machine } = await conversation();
		const call = {
			id: "item_1",
			type: "mcp_tool_call",
			server: "gateweave",
			tool: "acme__search",
			arguments: { query: "flaky" },
			result: null,
			error: null,
			status: "in_progress",
		};
		await machine.scriptEngine({
			lines: [
				event("thread.started", { thread_id: "thread-1" }),
				event("turn.started"),
				item("item.started", call),
				item("item.completed", {
					...call,
					result: {
						content: [{ type: "text", text: JSON.stringify({ issues: ["TRK-1"] }) }],
						structured_content: null,
					},
					status: "completed",
				}),
				item("item.completed", { id: "item_2", type: "agent_message", text: "TRK-1 is flaky." }),
				event("turn.completed", { usage: usage(100, 0, 5) }),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Which issues are flaky?");
		socket.close();

		expect(turn).toMatchObject({ text: "TRK-1 is flaky.", error: null });
		const chunks = chunksOf(turn);
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "tool-input-available", toolName: "acme__search" }),
		);
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "tool-output-available", output: { issues: ["TRK-1"] } }),
		);
		expect(turn.raw.join("\n")).not.toContain("codex__");
		const [run] = await registry.listRuns();
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toEqual([]);
	});

	it("fails the turn in the app's words when OpenAI refuses the key, never quoting it", async () => {
		const { registry, stub, machine } = await conversation();
		const refusal =
			"OpenAI refused the workspace's key. An owner or admin can check it in Settings.";
		// As Codex 0.165.0 words OpenAI's 401, with the masked key in the body.
		const words =
			'unexpected status 401 Unauthorized: {"error":{"message":"Incorrect API key provided: sk-gatew****lder."}}, url: https://api.openai.com/v1/responses';
		await machine.scriptEngine({
			lines: [
				event("thread.started", { thread_id: "thread-1" }),
				event("turn.started"),
				event("error", { message: words }),
				event("turn.failed", { error: { message: words } }),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe(refusal);
		expect(turn.raw.join("\n")).not.toContain("sk-gatew");
		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "failed", error: refusal });
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "model")).toMatchObject([
			{ status: "error", inputTokens: 0 },
		]);
	});

	it("names the limit when OpenAI limits the workspace's requests", async () => {
		const { stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [
				event("turn.started"),
				event("turn.failed", {
					error: { message: "exceeded retry limit, last status: 429 Too Many Requests" },
				}),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe("OpenAI is limiting the workspace's requests. Try again shortly.");
	});

	it("quotes Codex for a failure the app has no words for, with anything like a key taken out", async () => {
		const { stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [
				event("turn.started"),
				event("turn.failed", {
					error: { message: "stream disconnected before completion: sk-proj-abc****xyz went away" },
				}),
			],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe(
			"Codex could not finish: stream disconnected before completion: [key] went away",
		);
	});

	it("fails the turn when Codex stops before the turn ends", async () => {
		const { registry, stub, machine } = await conversation();
		await machine.scriptEngine({
			lines: [event("thread.started", { thread_id: "thread-1" }), event("turn.started")],
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Hello");
		socket.close();

		expect(turn.error).toBe("Codex stopped before it finished.");
		expect((await registry.listRuns())[0]).toMatchObject({ status: "failed" });
	});
});

describe("Codex's command", () => {
	const base = { model: "gpt-5.5", system: "", resume: false, tools: false };
	const settings = (argv: string[]) =>
		argv.flatMap((arg, at) => (argv[at - 1] === "-c" ? [arg] : []));

	it("runs it headless, unasked, with Gateweave's settings alone and the message on its input", () => {
		const argv = codexArguments(base);
		expect(argv.slice(0, 2)).toEqual(["exec", "--json"]);
		for (const flag of [
			"--skip-git-repo-check",
			"--dangerously-bypass-approvals-and-sandbox",
			"--ignore-user-config",
		]) {
			expect(argv).toContain(flag);
		}
		expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5.5");
		expect(argv.at(-1)).toBe("-");
		expect(argv).not.toContain("resume");
	});

	it("sends its requests to OpenAI over HTTPS, with the key from its own variable", () => {
		const config = settings(codexArguments(base));
		expect(config).toContain('model_provider="gateweave"');
		expect(config).toContain(
			'model_providers.gateweave={name="OpenAI",base_url="https://api.openai.com/v1",env_key="GATEWEAVE_OPENAI_KEY",wire_api="responses",supports_websockets=false}',
		);
		expect(config).toContain('web_search="disabled"');
		expect(CODEX_ENV.GATEWEAVE_OPENAI_KEY).toBe(CODEX_PLACEHOLDER_KEY);
	});

	it("leaves Codex its own home, which a new container does not have yet", () => {
		// Codex 0.165.0 exits before its first event when CODEX_HOME names a folder that does not
		// exist, as staging showed; its default, ~/.codex, it creates.
		expect(CODEX_ENV).not.toHaveProperty("CODEX_HOME");
	});

	it("resumes the sandbox's thread wherever it worked", () => {
		expect(codexArguments({ ...base, resume: true }).slice(0, 4)).toEqual([
			"exec",
			"resume",
			"--last",
			"--all",
		]);
	});

	it("names Gateweave's MCP server, with its tools up front, only when the turn has tools", () => {
		expect(settings(codexArguments(base)).some((value) => value.startsWith("mcp_servers"))).toBe(
			false,
		);
		expect(settings(codexArguments({ ...base, tools: true }))).toContain(
			'mcp_servers.gateweave={url="http://tools.gateweave.internal/mcp",startup_timeout_sec=60,tool_timeout_sec=3600,omit_tools_from=["deferred"]}',
		);
	});

	it("passes the agent's instructions as a TOML string, whatever they hold", () => {
		const system = 'Say "hi"\\ then\n\tgo\u007f';
		expect(settings(codexArguments({ ...base, system }))).toContain(
			`developer_instructions=${tomlString(system)}`,
		);
		expect(tomlString(system)).toBe('"Say \\"hi\\"\\\\ then\\n\\tgo\\u007F"');
		// A lone surrogate is no character TOML can escape.
		expect(tomlString("a\ud800b")).toBe('"a�b"');
	});

	it("is `codex`, with the message after the conversation so far when it lost the thread", () => {
		const job = {
			engine: "codex" as const,
			prompt: "And the folders?",
			history: "The person: List the files",
			system: "",
			provider: "openai" as const,
			model: "gpt-5.5",
			cwd: "/workspace",
			access: {
				key: KEY,
				metadata: { workspace: "w", agent: "a", conversation: "c" },
				tools: null,
			},
		};
		const fresh = codexCommand(job, false);
		expect(fresh.argv[0]).toBe("codex");
		expect(fresh.input).toContain("The person: List the files");
		expect(fresh.input.endsWith("And the folders?")).toBe(true);
		expect(fresh.env).toBe(CODEX_ENV);
		expect(codexCommand(job, true).input).toBe("And the folders?");
	});
});

describe("OpenAI from the sandbox", () => {
	const responses = new URL("https://api.openai.com/v1/responses");

	it("is reachable only while a turn calls OpenAI's models, and only for them", () => {
		expect(decideOutbound("POST", responses)).toMatchObject({ allow: false });
		expect(decideOutbound("POST", responses, null, "anthropic")).toMatchObject({ allow: false });
		expect(decideOutbound("POST", responses, null, "openai")).toEqual({
			allow: true,
			credentials: "openai",
		});
		expect(decideOutbound("GET", responses, null, "openai")).toMatchObject({ allow: false });
		for (const other of ["https://api.openai.com/v1/files", "https://api.openai.com/v1/models"]) {
			expect(decideOutbound("POST", new URL(other), null, "openai")).toMatchObject({
				allow: false,
			});
		}
		// Nor is Anthropic open to a turn that calls OpenAI.
		const messages = new URL("https://api.anthropic.com/v1/messages");
		expect(decideOutbound("POST", messages, null, "openai")).toMatchObject({ allow: false });
	});

	it("gets the workspace's key in place of the placeholder", async () => {
		const request = new Request(responses, {
			method: "POST",
			headers: { authorization: `Bearer ${CODEX_PLACEHOLDER_KEY}` },
			body: '{"model":"gpt-5.5"}',
		});
		const metadata = { workspace: "w", agent: "a", conversation: "c" };
		const out = openaiRequest(request, KEY, {}, metadata);
		expect(out.url).toBe("https://api.openai.com/v1/responses");
		expect(out.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(await out.text()).toBe('{"model":"gpt-5.5"}');
	});

	it("goes through AI Gateway when the deployment names one", () => {
		const gateway = "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/track";
		const request = new Request(`${responses.href}?stream=true`, {
			method: "POST",
			headers: { authorization: `Bearer ${CODEX_PLACEHOLDER_KEY}` },
			body: "{}",
		});
		const metadata = { workspace: "w", agent: "a", conversation: "c" };
		const out = openaiRequest(
			request,
			KEY,
			{ AI_GATEWAY_URL: gateway, AI_GATEWAY_TOKEN: "gateway-token" },
			metadata,
		);
		expect(out.url).toBe(`${gateway}/openai/responses?stream=true`);
		expect(out.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(out.headers.get("cf-aig-metadata")).toBe(JSON.stringify(metadata));
		expect(out.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
	});
});
