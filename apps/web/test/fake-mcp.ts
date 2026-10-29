/**
 * An MCP server over Streamable HTTP, as small as the tests need, like the runtime's own: it
 * answers each request with JSON, offers the tools it was given and answers their calls with
 * `call`. Pass `handle` to `startAgents` under the server's host.
 */
export interface FakeTool {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

type CallResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export class FakeMcpServer {
	/** Every JSON-RPC method asked for, with the request's headers and the call's arguments. */
	readonly requests: { method: string; headers: Headers; params?: unknown }[] = [];
	readonly #tools: FakeTool[];
	readonly #call: (name: string, input: unknown) => CallResult;

	constructor(tools: FakeTool[], call: (name: string, input: unknown) => CallResult) {
		this.#tools = tools;
		this.#call = call;
	}

	handle = async (request: Request): Promise<Response> => {
		// No stream of its own for the client to listen to, and no session to end.
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const message = (await request.json()) as {
			id?: number | string;
			method: string;
			params?: { name?: string; arguments?: unknown };
		};
		this.requests.push({
			method: message.method,
			headers: new Headers(request.headers),
			params: message.params,
		});
		if (message.id === undefined) return new Response(null, { status: 202 });
		const result = (value: unknown) =>
			Response.json({ jsonrpc: "2.0", id: message.id, result: value });
		switch (message.method) {
			case "initialize":
				return result({
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "fake", version: "1.0.0" },
				});
			case "tools/list":
				return result({ tools: this.#tools });
			case "tools/call":
				return result(this.#call(message.params?.name ?? "", message.params?.arguments));
			default:
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: "Method not found" },
				});
		}
	};
}
