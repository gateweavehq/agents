import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type AgentsAccess, createAgentsServer } from "./tools";

/**
 * A real MCP client connected to `createAgentsServer` over the streamable HTTP transport, with no
 * network in between. Shared by the tests that talk to the server the way a client does.
 */
export async function connect(access: AgentsAccess, canRun = false) {
	const handler = createMcpHandler(() => createAgentsServer(access, canRun));
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://agents.example.com/mcp"), {
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		}),
	);
	return client;
}
