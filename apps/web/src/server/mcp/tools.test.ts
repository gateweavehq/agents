import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { type AgentsAccess, createAgentsServer } from "./tools";

async function connect(access: AgentsAccess) {
	const handler = createMcpHandler(() => createAgentsServer(access));
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://agents.example.com/mcp"), {
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		}),
	);
	return client;
}

it("offers list_workspaces, which returns what access gives it and nothing more", async () => {
	const client = await connect({
		workspaces: async () => [{ slug: "acme", name: "Acme", role: "owner" }],
	});

	const { tools } = await client.listTools();
	expect(tools.map((tool) => tool.name)).toEqual(["list_workspaces"]);
	expect(tools[0]?.annotations?.readOnlyHint).toBe(true);

	const result = await client.callTool({ name: "list_workspaces", arguments: {} });
	expect(result.structuredContent).toEqual({
		workspaces: [{ slug: "acme", name: "Acme", role: "owner" }],
	});
	await client.close();
});
