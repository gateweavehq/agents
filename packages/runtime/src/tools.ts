/**
 * The tools of an agent's MCP servers, for one turn. Each turn connects anew with `@ai-sdk/mcp`
 * and closes the connections when it ends. The headers carry secrets from the agent's environment
 * set, which live only in memory for the turn; the Agents SDK's `addMcpServer` would store them in
 * the conversation's SQLite and keep the connection open.
 */
import { createMCPClient, type MCPClient, MCPClientError } from "@ai-sdk/mcp";
import { MCP_CHECK_LIMITS, type McpCheckResult, type TurnMcpServer } from "@gateweave/agents-model";
import type { ToolSet } from "ai";
import { z } from "zod";
import { failureForLogs } from "./models";
import type { RunRecorder } from "./trace";

/** How long a server has to connect and list its tools. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Providers take tool names of up to 64 letters, digits, `_` and `-`. */
const TOOL_NAME = { length: 64, unsafe: /[^A-Za-z0-9_-]/g };

export interface TurnTools {
	/** Every server's tools, named `<server>__<tool>` so that two servers cannot clash. */
	tools: ToolSet;
	/** Closes every connection. Safe to call more than once. */
	close(): Promise<void>;
}

/**
 * Connects to each server at once and gathers their tools. A server that cannot be reached is a
 * failed span in the trace, and the turn goes on without it.
 */
export async function connectTools(
	servers: TurnMcpServer[],
	run: RunRecorder,
	signal?: AbortSignal,
): Promise<TurnTools> {
	const connected = await Promise.all(servers.map((server) => connect(server, run, signal)));
	const clients: MCPClient[] = [];
	const tools: ToolSet = {};
	for (const server of connected) {
		if (!server) continue;
		clients.push(server.client);
		for (const [name, tool] of Object.entries(server.tools)) {
			const toolName = toolNameOf(server.name, name);
			// Names that only differ in characters a provider refuses: the first one wins.
			if (!(toolName in tools)) tools[toolName] = traced(tool, server.name, name, run);
		}
	}
	let closing: Promise<void> | undefined;
	return {
		tools,
		close: () => {
			closing ??= Promise.allSettled(clients.map((client) => client.close())).then(() => {});
			return closing;
		},
	};
}

async function connect(server: TurnMcpServer, run: RunRecorder, signal?: AbortSignal) {
	if ("problem" in server) {
		run.serverLeftOut(server.name, server.problem);
		return null;
	}
	const span = run.serverConnecting(server.name);
	const { deadline, options } = timeLimit(signal);
	let opened: Awaited<ReturnType<typeof openClient>> | undefined;
	try {
		opened = await openClient(server, options);
		const { client, definitions } = opened;
		// The allowlist names the server's own tool names; one it does not offer is just absent.
		const allowed = server.tools && new Set(server.tools);
		const tools = client.toolsFromDefinitions(
			allowed
				? { ...definitions, tools: definitions.tools.filter((tool) => allowed.has(tool.name)) }
				: definitions,
		);
		run.serverConnected(span, Object.keys(tools).length);
		return { name: server.name, client, tools };
	} catch (error) {
		await opened?.client.close().catch(() => {});
		run.serverFailed(span, describeServerFailure(error, deadline));
		console.error("An MCP server did not connect", {
			server: server.name,
			...failureForLogs(error),
		});
		return null;
	}
}

/**
 * Whether a server can be reached with these headers, and the tools it lists: what the MCP page
 * records. It connects the way a turn does and always closes the connection. The result holds
 * the server's tool names and descriptions, which are its own public description of itself;
 * a failure is in the app's words, and neither the headers nor what the server said are kept.
 */
export async function checkMcpServer(server: TurnMcpServer): Promise<McpCheckResult> {
	if ("problem" in server) return { ok: false, error: server.problem };
	const { deadline, options } = timeLimit();
	let opened: Awaited<ReturnType<typeof openClient>> | undefined;
	try {
		opened = await openClient(server, options);
		return {
			ok: true,
			tools: opened.definitions.tools.slice(0, MCP_CHECK_LIMITS.tools).map((tool) => ({
				name: shorten(tool.name, MCP_CHECK_LIMITS.name),
				description: shorten(tool.description ?? "", MCP_CHECK_LIMITS.description),
			})),
		};
	} catch (error) {
		console.error("An MCP server check failed", { server: server.name, ...failureForLogs(error) });
		return { ok: false, error: describeServerFailure(error, deadline) };
	} finally {
		await opened?.client.close().catch(() => {});
	}
}

/** Who a Gateweave Track agent member's key is in Track. */
export interface TrackAgentIdentity {
	/** The slug of the one workspace the key reaches. */
	workspace: string;
	/** The member's id, which Track's issues name as their assignee. */
	memberId: string;
	name: string;
}

const trackWorkspaces = z.object({
	workspaces: z.array(z.object({ slug: z.string().min(1), role: z.string() })),
});
const trackYou = z.object({
	you: z.object({ id: z.string().min(1).max(64), name: z.string(), role: z.string() }),
});

/**
 * Checks a Gateweave Track MCP server as `checkMcpServer` does, then asks which member the key
 * belongs to: the one workspace `list_workspaces` lists, and the member `get_workspace` names as
 * `you`. An `identity` that is a problem says why in the app's words, such as a Track too old to
 * say, or a key that is not an agent member's. The key stays in this call's memory.
 */
export async function checkTrackAgent(
	server: TurnMcpServer,
): Promise<{ check: McpCheckResult; identity: TrackAgentIdentity | { problem: string } }> {
	if ("problem" in server) {
		return { check: { ok: false, error: server.problem }, identity: { problem: server.problem } };
	}
	const { deadline, options } = timeLimit();
	let opened: Awaited<ReturnType<typeof openClient>> | undefined;
	try {
		opened = await openClient(server, options);
		const check: McpCheckResult = {
			ok: true,
			tools: opened.definitions.tools.slice(0, MCP_CHECK_LIMITS.tools).map((tool) => ({
				name: shorten(tool.name, MCP_CHECK_LIMITS.name),
				description: shorten(tool.description ?? "", MCP_CHECK_LIMITS.description),
			})),
		};
		const listed = trackWorkspaces.safeParse(
			(await opened.client.callTool({ name: "list_workspaces", arguments: {}, options }))
				.structuredContent,
		);
		const [only, ...others] = listed.success ? listed.data.workspaces : [];
		if (!only || others.length > 0 || only.role !== "agent") {
			return { check, identity: { problem: "This key is not an agent member's key" } };
		}
		const found = trackYou.safeParse(
			(
				await opened.client.callTool({
					name: "get_workspace",
					arguments: { workspace: only.slug },
					options,
				})
			).structuredContent,
		);
		if (!found.success) {
			return {
				check,
				identity: {
					problem:
						"This Track does not say which member a key belongs to; it needs an update first",
				},
			};
		}
		const { id, name } = found.data.you;
		return { check, identity: { workspace: only.slug, memberId: id, name } };
	} catch (error) {
		console.error("A Track check failed", { server: server.name, ...failureForLogs(error) });
		const problem = describeServerFailure(error, deadline);
		return { check: { ok: false, error: problem }, identity: { problem } };
	} finally {
		await opened?.client.close().catch(() => {});
	}
}

function shorten(text: string, length: number): string {
	const clean = text.trim();
	return clean.length <= length ? clean : `${clean.slice(0, length - 1)}…`;
}

/** The limit on connecting and listing tools, joined with the caller's own signal. */
function timeLimit(signal?: AbortSignal) {
	const deadline = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
	return { deadline, options: { signal: signal ? AbortSignal.any([signal, deadline]) : deadline } };
}

/**
 * The one way to a server's tools, for turns and checks: connects, initializes and lists them.
 * It closes the client itself when that fails; the caller closes it otherwise.
 */
async function openClient(
	server: Extract<TurnMcpServer, { url: string }>,
	options: { signal: AbortSignal },
) {
	let client: MCPClient | undefined;
	try {
		client = await createMCPClient({
			clientName: "gateweave-agents",
			transport: {
				type: server.transport,
				url: server.url,
				headers: server.headers,
				fetch: fetchWithoutRedirects,
			},
			initializationOptions: options,
		});
		return { client, definitions: await client.listTools({ options }) };
	} catch (error) {
		await client?.close().catch(() => {});
		throw error;
	}
}

/**
 * The client refuses redirects with `redirect: "error"`, which Workers do not take. This does the
 * same with `manual`: the server's 3xx answer is the failure, and the agent's headers never go to
 * the address it names.
 */
const fetchWithoutRedirects: typeof fetch = (input, init) =>
	fetch(input, { ...init, redirect: "manual" });

/**
 * How a traced tool's failures are recorded. A tool of the app's own (the sandbox's, and
 * `open_pull_request`) says what went wrong in words written for the model, so its message is
 * recorded; an MCP server's message can carry what a third party answered, so it is not.
 */
export interface TraceOptions {
	/** Record the message the tool threw, not only that the call failed. */
	showErrors?: boolean;
}

/** The longest failure the trace records, the message included. */
export const FAILURE_LIMIT = 500;

/** A tool that records each call as a span: its timing and sizes, never its input or output. */
export function traced(
	tool: ToolSet[string],
	server: string,
	name: string,
	run: RunRecorder,
	options: TraceOptions = {},
): ToolSet[string] {
	const { execute } = tool;
	if (!execute) return tool;
	return {
		...tool,
		execute: async (input, callOptions) => {
			const span = run.toolStarted(server, name, byteSize(input));
			try {
				const output: unknown = await execute(input, callOptions);
				run.toolEnded(span, {
					outputBytes: byteSize(output),
					error: isToolError(output) ? "The tool answered with an error" : null,
				});
				return output;
			} catch (error) {
				run.toolEnded(span, { error: describeToolFailure(error, options) });
				throw error;
			}
		},
	} as ToolSet[string];
}

function toolNameOf(server: string, tool: string): string {
	const safe = (text: string) => text.replace(TOOL_NAME.unsafe, "_");
	return `${safe(server)}__${safe(tool)}`.slice(0, TOOL_NAME.length);
}

function byteSize(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

/** MCP reports a tool's own failure in its result, which the model reads like any answer. */
function isToolError(output: unknown): boolean {
	return typeof output === "object" && output !== null && "isError" in output && !!output.isError;
}

/** Why a server could not be reached, in the app's words: what it said is not shown. */
export function describeServerFailure(error: unknown, deadline?: AbortSignal): string {
	if (deadline?.aborted) {
		return `It did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds`;
	}
	const status = MCPClientError.isInstance(error) ? error.statusCode : undefined;
	if (status === 401 || status === 403) {
		return `It refused the agent's credentials (HTTP ${status}). Check the values its headers take from the environment set`;
	}
	if (status !== undefined && status >= 300 && status < 400) {
		return `It sends the agent to another address, which agents do not follow (HTTP ${status})`;
	}
	if (status === 404) return "Nothing answers at its URL (HTTP 404)";
	if (status === 405) return "It does not take this transport (HTTP 405). Try the other one";
	if (status !== undefined) return `It answered with an error (HTTP ${status})`;
	return "It could not be reached";
}

function describeToolFailure(error: unknown, { showErrors = false }: TraceOptions): string {
	if (error instanceof Error && error.name === "AbortError") return "The turn was stopped";
	if (showErrors && error instanceof Error && error.message.trim() !== "") {
		return clip(`The call failed: ${error.message.trim()}`, FAILURE_LIMIT);
	}
	const status = MCPClientError.isInstance(error) ? error.statusCode : undefined;
	return status === undefined
		? "The call failed"
		: `The call failed: the server answered with an error (HTTP ${status})`;
}

/** `text` at most `length` characters long, the last one an ellipsis when it had to be cut. */
function clip(text: string, length: number): string {
	return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
