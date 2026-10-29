/**
 * Gateweave's tools for Claude Code (AGT-44): the agent's MCP servers, `open_pull_request` and a
 * team's edges, served to the CLI as one MCP server named `gateweave`. Claude Code reaches it at
 * `CLAUDE_CODE_TOOLS_URL`, a host that exists only inside the sandbox: `SandboxOutbound` takes the
 * request and hands it to the conversation, which runs each call the way Gateweave's own loop
 * would. So the secrets in an MCP server's headers, the GitHub App and the other conversations of
 * a team stay in the Worker, and each call is a span in the run's trace as in any other turn.
 *
 * Each request gets a fresh server from `createMcpHandler`, which answers the 2026-07-28 revision
 * and the stateless 2025 one, whichever the CLI speaks.
 *
 * Checked 2026-10-29:
 * - `createMcpHandler` and `fromJsonSchema`: `index.d.mts` of @modelcontextprotocol/server 2.3.1
 * - `--mcp-config`, `--strict-mcp-config`, a server's `timeout`, and `mcp__<server>` in allowed
 *   tools: https://code.claude.com/docs/en/cli-reference and https://code.claude.com/docs/en/mcp
 * - per-request limits of HTTP servers and automatic backgrounding:
 *   https://code.claude.com/docs/en/env-vars (`MCP_TOOL_TIMEOUT`,
 *   `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`)
 */
import {
	type CallToolResult,
	createMcpHandler,
	fromJsonSchema,
	type JsonSchemaType,
	McpServer,
} from "@modelcontextprotocol/server";
import { asSchema, type ModelMessage, type ToolSet } from "ai";
import { CLAUDE_CODE_TOOLS_HOST, CLAUDE_CODE_TOOLS_PATH } from "./outbound";

/** The name Claude Code knows the server by, which prefixes its tools: `mcp__gateweave__<tool>`. */
export const CLAUDE_CODE_TOOLS_SERVER = "gateweave";

/** What Claude Code calls Gateweave's tools, before their own names. */
export const CLAUDE_CODE_TOOL_PREFIX = `mcp__${CLAUDE_CODE_TOOLS_SERVER}__`;

/**
 * Where Claude Code reaches the server. Plain HTTP: the request never leaves Cloudflare, since the
 * sandbox's network hands every request to `SandboxOutbound`.
 */
export const CLAUDE_CODE_TOOLS_URL = `http://${CLAUDE_CODE_TOOLS_HOST}${CLAUDE_CODE_TOOLS_PATH}`;

/** How the sandbox's requests reach the conversation's tools while a turn has them. */
export interface ClaudeCodeToolsAccess {
	/** The conversation's Durable Object, by name. */
	conversation: string;
	/** Made for the turn: a request without it gets no tools. */
	token: string;
}

/**
 * The `--mcp-config` that names the server. Its `timeout`, the turn's own limit, lifts the 60
 * seconds an HTTP server's request may take otherwise: a delegated task can take that long.
 */
export function claudeCodeMcpConfig(timeoutMs: number): string {
	return JSON.stringify({
		mcpServers: {
			[CLAUDE_CODE_TOOLS_SERVER]: { type: "http", url: CLAUDE_CODE_TOOLS_URL, timeout: timeoutMs },
		},
	});
}

/**
 * A request of Claude Code's as it goes to the conversation over RPC, which takes no
 * `AbortSignal`. The conversation cancels the calls itself when the turn ends.
 */
export function toolsRequest(request: Request): Request {
	return new Request(request, { signal: null });
}

/** Answers one request of Claude Code's to the server, with the turn's tools. */
export async function serveClaudeCodeTools(
	tools: ToolSet,
	request: Request,
	signal: AbortSignal,
): Promise<Response> {
	const definitions = await Promise.all(
		Object.entries(tools).map(async ([name, tool]) => ({
			name,
			tool,
			// A description made per call gets no context, as none of the turn's tools takes one.
			description:
				typeof tool.description === "function"
					? tool.description({ context: undefined })
					: tool.description,
			jsonSchema: (await asSchema(tool.inputSchema).jsonSchema) as JsonSchemaType,
		})),
	);
	const handler = createMcpHandler(() => {
		const server = new McpServer({ name: CLAUDE_CODE_TOOLS_SERVER, version: "1.0.0" });
		for (const { name, tool, description, jsonSchema } of definitions) {
			server.registerTool(name, { description, inputSchema: fromJsonSchema(jsonSchema) }, (input) =>
				callTool(tool, input, signal),
			);
		}
		return server;
	});
	try {
		return await handler.fetch(request);
	} finally {
		await handler.close();
	}
}

/**
 * Runs one call as Gateweave's loop would, after the tool's own schema has checked the input. What
 * the tool throws is the model's to read, as the loop hands it on.
 */
async function callTool(
	tool: ToolSet[string],
	input: unknown,
	signal: AbortSignal,
): Promise<CallToolResult> {
	const { execute } = tool;
	if (!execute) return failure("This tool cannot be called");
	const checked = await asSchema(tool.inputSchema).validate?.(input);
	if (checked && !checked.success)
		return failure(`The input is not valid: ${checked.error.message}`);
	try {
		let output: unknown = await execute(checked ? checked.value : input, {
			toolCallId: crypto.randomUUID(),
			messages: [] as ModelMessage[],
			abortSignal: signal,
			context: undefined,
		});
		if (isAsyncIterable(output)) {
			// A tool that streams its output: the model reads the last of it, as the loop's does.
			for await (const part of output) output = part;
		}
		return resultOf(output);
	} catch (error) {
		return failure(error instanceof Error && error.message !== "" ? error.message : "It failed");
	}
}

/**
 * A tool's output as MCP's result. An MCP server's tool already answers with one; any other output
 * is JSON text, which the chat reads back to show it as Gateweave's loop does.
 */
function resultOf(output: unknown): CallToolResult {
	if (isCallToolResult(output)) return output;
	const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "");
	return { content: [{ type: "text", text }] };
}

function isCallToolResult(output: unknown): output is CallToolResult {
	return (
		typeof output === "object" &&
		output !== null &&
		"content" in output &&
		Array.isArray(output.content)
	);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function failure(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
