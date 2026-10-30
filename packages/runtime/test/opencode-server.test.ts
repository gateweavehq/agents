import { afterEach, describe, expect, it, vi } from "vitest";
import { type EngineJob, enginePrompt } from "../src/engines";
import { openCodeSettings } from "../src/opencode";
import {
	OPENCODE_SESSION_TITLE,
	type OpenCodeServerPort,
	startOpenCodeTurn,
} from "../src/opencode-server";

afterEach(() => {
	vi.restoreAllMocks();
});

interface Request {
	method: string;
	path: string;
	directory: string | null;
	body: unknown;
}

/**
 * A stand-in for `opencode serve`: its routes as a turn uses them, with sessions in memory, and
 * the events a test has it send once a message comes, then on a stop.
 */
class FakeServer implements OpenCodeServerPort {
	readonly ensured: Record<string, string>[] = [];
	readonly requests: Request[] = [];
	readonly sessions = new Set<string>();
	/** How many health checks fail before it answers, as a server that is starting. */
	startingFor = 0;
	/** Answers for some requests in place of the usual ones, by method and path. */
	readonly refusals = new Map<string, () => Response>();
	/** The events it sends once a message comes to a session. */
	onPrompt: (session: string) => object[] = () => [];
	/** The events it sends once a session is stopped. */
	onAbort: (session: string) => object[] = (session) => [aborted(session), idle(session)];
	readonly #streams: ReadableStreamDefaultController<Uint8Array>[] = [];

	async ensure(env: Record<string, string>): Promise<{ logFrom: number }> {
		this.ensured.push(env);
		return { logFrom: 42 };
	}

	async fetch(path: string, init?: RequestInit): Promise<Response> {
		const url = new URL(path, "http://opencode.internal");
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		this.requests.push({
			method,
			path: url.pathname,
			directory: url.searchParams.get("directory"),
			body,
		});
		if (url.pathname === "/global/health") {
			if (this.startingFor > 0) {
				this.startingFor -= 1;
				throw new Error("connection refused");
			}
			return Response.json({ healthy: true, version: "1.19.5" });
		}
		const refusal = this.refusals.get(`${method} ${url.pathname}`);
		if (refusal) return refusal();
		if (url.pathname === "/event") {
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					this.#streams.push(controller);
					controller.enqueue(frame({ type: "server.connected", properties: {} }));
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		}
		if (method === "POST" && url.pathname === "/session") {
			const id = `ses_${this.sessions.size + 1}`;
			this.sessions.add(id);
			return Response.json({ id, title: (body as { title?: string }).title });
		}
		if (method === "POST" && /^\/mcp\/[^/]+\/connect$/.test(url.pathname))
			return Response.json(true);
		if (method === "POST" && /^\/permission\/[^/]+\/reply$/.test(url.pathname)) {
			return Response.json(true);
		}
		const [, session = "", action] = /^\/session\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname) ?? [];
		if (method === "GET" && action === undefined) {
			return this.sessions.has(session)
				? Response.json({ id: session })
				: Response.json(
						{ name: "NotFoundError", data: { message: `Session not found: ${session}` } },
						{ status: 404 },
					);
		}
		if (method === "POST" && action === "prompt_async") {
			setTimeout(() => this.send(...this.onPrompt(session)), 0);
			return new Response(null, { status: 204 });
		}
		if (method === "POST" && action === "abort") {
			setTimeout(() => this.send(...this.onAbort(session)), 0);
			return Response.json(true);
		}
		return new Response("Not found", { status: 404 });
	}

	send(...events: object[]): void {
		for (const stream of this.#streams) {
			for (const event of events) stream.enqueue(frame(event));
		}
	}

	/** Ends its event streams, as a server that stopped. */
	end(): void {
		for (const stream of this.#streams) stream.close();
	}

	requested(method: string, path: string): Request[] {
		return this.requests.filter((request) => request.method === method && request.path === path);
	}
}

/** An event as the server sends it. */
function frame(event: object): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function part(session: string, value: object): object {
	return {
		type: "message.part.updated",
		properties: {
			sessionID: session,
			part: { sessionID: session, messageID: "msg_2", ...value },
			time: 1,
		},
	};
}

function idle(session: string): object {
	return { type: "session.status", properties: { sessionID: session, status: { type: "idle" } } };
}

function aborted(session: string): object {
	return {
		type: "session.error",
		properties: {
			sessionID: session,
			error: { name: "MessageAbortedError", data: { message: "Aborted" } },
		},
	};
}

const tokens = { total: 0, input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } };

/** A turn that runs a command, then answers, with the updates the server sends meanwhile. */
function listing(session: string): object[] {
	const bash = {
		id: "prt_tool",
		type: "tool",
		callID: "toolu_1",
		tool: "bash",
		state: { status: "running", input: { command: "ls" }, time: { start: 1 } },
	};
	const done = {
		...bash,
		state: {
			status: "completed",
			input: { command: "ls" },
			output: "a.txt\n",
			time: { start: 1, end: 5 },
		},
	};
	return [
		// The person's own message, which has no end.
		part(session, { id: "prt_user", messageID: "msg_1", type: "text", text: "List the files" }),
		{ type: "session.status", properties: { sessionID: session, status: { type: "busy" } } },
		part(session, { id: "prt_s1", type: "step-start" }),
		part(session, { id: "prt_t1", type: "text", text: "", time: { start: 1 } }),
		{
			type: "message.part.delta",
			properties: { sessionID: session, partID: "prt_t1", delta: "Let me look." },
		},
		part(session, { id: "prt_t1", type: "text", text: "Let me look.", time: { start: 1, end: 2 } }),
		part(session, bash),
		part(session, done),
		part(session, done),
		part(session, { id: "prt_f1", type: "step-finish", reason: "tool-calls", tokens }),
		// Another session's, which is not this turn's.
		part("ses_other", { id: "prt_x", type: "text", text: "Not mine", time: { start: 1, end: 2 } }),
		part(session, { id: "prt_s2", type: "step-start" }),
		part(session, { id: "prt_t2", type: "text", text: "One file.", time: { start: 6, end: 7 } }),
		part(session, { id: "prt_f2", type: "step-finish", reason: "stop", tokens }),
		idle(session),
	];
}

const JOB: EngineJob = {
	engine: "opencode",
	prompt: "And the folders?",
	history: "The person: List the files",
	system: "Be brief.",
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	cwd: "/workspace/repo",
	access: {
		key: "sk-ant-secret",
		metadata: { workspace: "w", agent: "a", conversation: "c" },
		tools: null,
	},
};

const TOOLS = { conversation: "c", token: "t" };

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
	const text = await new Response(stream).text();
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

describe("a turn on OpenCode's server", () => {
	it("starts a session with the conversation so far, and prints the turn as `opencode run` does", async () => {
		const server = new FakeServer();
		server.onPrompt = listing;
		const turn = await startOpenCodeTurn(server, JOB, undefined);
		const lines = await linesOf(turn.events);
		expect(lines.map((line) => line.type)).toEqual([
			"step_start",
			"text",
			"tool_use",
			"step_finish",
			"step_start",
			"text",
			"step_finish",
		]);
		expect(lines[1]).toMatchObject({
			sessionID: "ses_1",
			part: { type: "text", text: "Let me look.", time: { end: 2 } },
		});
		expect(lines[2]).toMatchObject({
			part: { callID: "toolu_1", tool: "bash", state: { status: "completed", output: "a.txt\n" } },
		});
		expect(lines[3]).toMatchObject({ part: { reason: "tool-calls", tokens } });
		await turn.ended;
		expect(turn).toMatchObject({ session: "ses_1", logFrom: 42 });

		expect(server.ensured).toEqual([openCodeSettings(JOB)]);
		expect(server.requested("POST", "/session")[0]?.body).toEqual({
			title: OPENCODE_SESSION_TITLE,
			permission: [
				{ permission: "question", action: "deny", pattern: "*" },
				{ permission: "plan_enter", action: "deny", pattern: "*" },
				{ permission: "plan_exit", action: "deny", pattern: "*" },
			],
		});
		const [prompt] = server.requested("POST", "/session/ses_1/prompt_async");
		expect(prompt?.body).toEqual({
			model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" },
			parts: [{ type: "text", text: enginePrompt(JOB, false) }],
		});
		expect(enginePrompt(JOB, false)).toContain("The person: List the files");
		// Each request is for the turn's project, but the server's health.
		for (const request of server.requests) {
			expect(request.directory).toBe(request.path === "/global/health" ? null : "/workspace/repo");
		}
		expect(server.requested("POST", "/mcp/gateweave/connect")).toEqual([]);
	});

	it("continues the session the server still has, with the message alone", async () => {
		const server = new FakeServer();
		server.sessions.add("ses_7");
		server.onPrompt = (session) => [idle(session)];
		const turn = await startOpenCodeTurn(server, JOB, "ses_7");
		await linesOf(turn.events);
		expect(turn.session).toBe("ses_7");
		expect(server.requested("POST", "/session")).toEqual([]);
		expect(server.requested("POST", "/session/ses_7/prompt_async")[0]?.body).toMatchObject({
			parts: [{ type: "text", text: "And the folders?" }],
		});
	});

	it("starts a new session with the conversation so far when the server no longer has the old one", async () => {
		const server = new FakeServer();
		server.onPrompt = (session) => [idle(session)];
		const turn = await startOpenCodeTurn(server, JOB, "ses_gone");
		await linesOf(turn.events);
		expect(turn.session).toBe("ses_1");
		expect(server.requested("GET", "/session/ses_gone")).toHaveLength(1);
		expect(server.requested("POST", "/session/ses_1/prompt_async")[0]?.body).toMatchObject({
			parts: [{ type: "text", text: enginePrompt(JOB, false) }],
		});
	});

	it("reconnects Gateweave's tools before the message, so that the server lists the turn's own", async () => {
		const server = new FakeServer();
		server.onPrompt = (session) => [idle(session)];
		const job = { ...JOB, access: { ...JOB.access, tools: TOOLS } };
		await linesOf((await startOpenCodeTurn(server, job, undefined)).events);
		const paths = server.requests.map((request) => `${request.method} ${request.path}`);
		expect(paths.indexOf("POST /mcp/gateweave/connect")).toBeGreaterThan(-1);
		expect(paths.indexOf("POST /mcp/gateweave/connect")).toBeLessThan(
			paths.indexOf("POST /session/ses_1/prompt_async"),
		);
		expect(server.ensured[0]).toEqual(openCodeSettings(job));
	});

	it("waits for a server that has just started", async () => {
		const server = new FakeServer();
		server.startingFor = 3;
		server.onPrompt = (session) => [idle(session)];
		const turn = await startOpenCodeTurn(server, JOB, undefined, { pollMs: 1 });
		await linesOf(turn.events);
		expect(server.requested("GET", "/global/health")).toHaveLength(4);
		expect(turn.session).toBe("ses_1");
	});

	it("answers OpenCode's permission requests once, as `--auto` does, for its own sessions alone", async () => {
		const server = new FakeServer();
		server.onPrompt = (session) => [
			{
				type: "permission.asked",
				properties: { id: "per_1", sessionID: session, permission: "bash" },
			},
			{ type: "permission.asked", properties: { id: "per_2", sessionID: "ses_other" } },
			{ type: "session.created", properties: { info: { id: "ses_child", parentID: session } } },
			{ type: "permission.asked", properties: { id: "per_3", sessionID: "ses_child" } },
			idle(session),
		];
		await linesOf((await startOpenCodeTurn(server, JOB, undefined)).events);
		const replies = server.requests.filter((request) => request.path.startsWith("/permission/"));
		expect(replies).toEqual([
			{
				method: "POST",
				path: "/permission/per_1/reply",
				directory: "/workspace/repo",
				body: { reply: "once" },
			},
			{
				method: "POST",
				path: "/permission/per_3/reply",
				directory: "/workspace/repo",
				body: { reply: "once" },
			},
		]);
	});

	it("passes on OpenCode's failure as `opencode run` prints it", async () => {
		const server = new FakeServer();
		const error = {
			name: "APIError",
			data: { message: "invalid x-api-key", statusCode: 401, isRetryable: false },
		};
		server.onPrompt = (session) => [
			{ type: "session.error", properties: { sessionID: session, error } },
			{ type: "session.error", properties: { sessionID: "ses_other", error } },
			idle(session),
		];
		const lines = await linesOf((await startOpenCodeTurn(server, JOB, undefined)).events);
		expect(lines).toEqual([
			{ type: "error", timestamp: expect.any(Number), sessionID: "ses_1", error },
		]);
	});

	it("stops the session, and ends without the failure that says so once it is idle", async () => {
		const server = new FakeServer();
		server.onPrompt = (session) => [part(session, { id: "prt_s1", type: "step-start" })];
		const turn = await startOpenCodeTurn(server, JOB, undefined);
		const reading = linesOf(turn.events);
		await vi.waitUntil(() => server.requested("POST", "/session/ses_1/prompt_async").length > 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await turn.stop();
		const lines = await reading;
		expect(lines.map((line) => line.type)).toEqual(["step_start"]);
		expect(server.requested("POST", "/session/ses_1/abort")).toHaveLength(1);
		await turn.ended;
	});

	it("ends a stopped turn anyway when the server never says it is idle", async () => {
		const server = new FakeServer();
		server.onAbort = () => [];
		const turn = await startOpenCodeTurn(server, JOB, undefined, { graceMs: 20 });
		const reading = linesOf(turn.events);
		await turn.stop();
		expect(await reading).toEqual([]);
		await turn.ended;
	});

	it("ends the turn when the server's events break off", async () => {
		const server = new FakeServer();
		server.onPrompt = (session) => {
			setTimeout(() => server.end(), 5);
			return [part(session, { id: "prt_s1", type: "step-start" })];
		};
		const turn = await startOpenCodeTurn(server, JOB, undefined);
		const lines = await linesOf(turn.events);
		expect(lines.map((line) => line.type)).toEqual(["step_start"]);
		await turn.ended;
	});

	it("fails the turn in OpenCode's words when the server refuses a request", async () => {
		const server = new FakeServer();
		server.refusals.set("POST /session", () =>
			Response.json(
				{
					name: "ConfigJsonError",
					data: { path: "OPENCODE_CONFIG_CONTENT", message: "Unexpected token" },
				},
				{ status: 400 },
			),
		);
		const turn = await startOpenCodeTurn(server, JOB, undefined);
		expect(await linesOf(turn.events)).toEqual([
			{
				type: "error",
				timestamp: expect.any(Number),
				error: { name: "ServerError", data: { message: "Unexpected token" } },
			},
		]);
		expect(turn.session).toBeNull();
		expect(server.requested("POST", "/session/ses_1/prompt_async")).toEqual([]);
	});

	it("fails the turn when its server never answers, and says so", async () => {
		const server = new FakeServer();
		server.startingFor = Number.POSITIVE_INFINITY;
		const turn = await startOpenCodeTurn(server, JOB, "ses_7", { startMs: 20, pollMs: 5 });
		expect(await linesOf(turn.events)).toMatchObject([
			{
				type: "error",
				error: { data: { message: "its server did not answer within 0.02 seconds" } },
			},
		]);
		expect(turn.session).toBe("ses_7");
	});

	it("fails the turn when the server cannot be started", async () => {
		const server = new FakeServer();
		vi.spyOn(server, "ensure").mockRejectedValue(new Error("bash: opencode: command not found"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const turn = await startOpenCodeTurn(server, JOB, undefined);
		expect(await linesOf(turn.events)).toMatchObject([
			{ type: "error", error: { data: { message: "its server could not be reached" } } },
		]);
		expect(errors).toHaveBeenCalled();
		expect(server.requests).toEqual([]);
	});
});
