/**
 * The tools of an agent's MCP servers, for one turn. Each turn connects anew with `@ai-sdk/mcp`
 * and closes the connections when it ends. The headers carry secrets from the agent's environment
 * set, which live only in memory for the turn; the Agents SDK's `addMcpServer` would store them in
 * the conversation's SQLite and keep the connection open.
 */
import { createMCPClient, type MCPClient, MCPClientError } from "@ai-sdk/mcp";
import type { TurnMcpServer } from "@gateweave/agents-model";
import type { ToolSet } from "ai";
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
	const deadline = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
	const options = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
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
		const tools = client.toolsFromDefinitions(await client.listTools({ options }));
		run.serverConnected(span, Object.keys(tools).length);
		return { name: server.name, client, tools };
	} catch (error) {
		await client?.close().catch(() => {});
		run.serverFailed(span, describeServerFailure(error, deadline));
		console.error("An MCP server did not connect", {
			server: server.name,
			...failureForLogs(error),
		});
		return null;
	}
}

/**
 * The client refuses redirects with `redirect: "error"`, which Workers do not take. This does the
 * same with `manual`: the server's 3xx answer is the failure, and the agent's headers never go to
 * the address it names.
 */
const fetchWithoutRedirects: typeof fetch = (input, init) =>
	fetch(input, { ...init, redirect: "manual" });

/** A tool that records each call as a span: its timing and sizes, never its input or output. */
function traced(
	tool: ToolSet[string],
	server: string,
	name: string,
	run: RunRecorder,
): ToolSet[string] {
	const { execute } = tool;
	if (!execute) return tool;
	return {
		...tool,
		execute: async (input, options) => {
			const span = run.toolStarted(server, name, byteSize(input));
			try {
				const output: unknown = await execute(input, options);
				run.toolEnded(span, {
					outputBytes: byteSize(output),
					error: isToolError(output) ? "The tool answered with an error" : null,
				});
				return output;
			} catch (error) {
				run.toolEnded(span, { error: describeToolFailure(error) });
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

function describeToolFailure(error: unknown): string {
	if (error instanceof Error && error.name === "AbortError") return "The turn was stopped";
	const status = MCPClientError.isInstance(error) ? error.statusCode : undefined;
	return status === undefined
		? "The call failed"
		: `The call failed: the server answered with an error (HTTP ${status})`;
}
