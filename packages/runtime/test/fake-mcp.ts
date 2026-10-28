/**
 * An MCP server over Streamable HTTP, as small as the tests need: it answers each request with
 * JSON, offers the tools it was given and answers their calls with `call`.
 */
export interface FakeTool {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

type CallResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export class FakeMcpServer {
	/** Every JSON-RPC method asked for, with the request's headers. */
	readonly requests: { method: string; headers: Headers }[] = [];
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
		this.requests.push({ method: message.method, headers: request.headers });
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
