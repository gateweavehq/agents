import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MEMBER_ROLES, type MemberRole } from "#/lib/roles";

// Agents' MCP tools. They only reach Agents through AgentsAccess, which offers what the signed-in
// user can see, and nothing more. Free of `cloudflare:workers` imports so the tools can be tested
// in Node.

/** What the tools may do for one signed-in user. */
export interface AgentsAccess {
	workspaces(): Promise<{ slug: string; name: string; role: MemberRole }[]>;
}

/** Wraps a tool's result as structured content, with the same data as text for clients without it. */
async function run<Result extends Record<string, unknown>>(
	work: () => Promise<Result>,
): Promise<CallToolResult> {
	const result = await work();
	return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

/**
 * The server one request talks to, made for the person it acts as. More tools go next to
 * `list_workspaces`, each reaching Agents through `access` alone.
 */
export function createAgentsServer(access: AgentsAccess): McpServer {
	const server = new McpServer({ name: "gateweave-agents", version: "1.0.0" });

	server.registerTool(
		"list_workspaces",
		{
			title: "List workspaces",
			description: "Lists the Agents workspaces you belong to. Start here to find a slug.",
			outputSchema: z.looseObject({
				workspaces: z.array(
					z.looseObject({ slug: z.string(), name: z.string(), role: z.enum(MEMBER_ROLES) }),
				),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => run(async () => ({ workspaces: await access.workspaces() })),
	);

	return server;
}
