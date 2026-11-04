/**
 * MCP servers that run as a local command, such as `npx @acme/mcp`: the conversation's sandbox
 * starts the command for the turn, and the conversation talks to it over its standard input and
 * output, one JSON-RPC message per line, as MCP's stdio transport does. The sandbox and the
 * conversation are two Durable Objects, so the two streams cross between them over RPC.
 *
 * The command gets the environment the registry filled from the agent's environment set, which
 * never holds a secret: the sandbox holds none (`./sandbox.ts`).
 */
import type { JSONRPCMessage, MCPTransport } from "@ai-sdk/mcp";

/** A local command to start, as the registry hands it over for a turn. */
export interface LocalCommand {
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** What starts a local MCP server: the conversation's sandbox. */
export interface LocalServerPort {
	/**
	 * Starts the command with `input` as its standard input, and returns its standard output. It
	 * stops when `input` ends.
	 */
	startMcpServer(
		command: LocalCommand,
		input: ReadableStream<Uint8Array>,
	): Promise<ReadableStream<Uint8Array>>;
}

/** Why a local server could not run, in the app's words. */
export class LocalServerError extends Error {}

/** The longest line the transport takes from a server, so a runaway one cannot fill memory. */
export const MAX_MESSAGE_BYTES = 4_000_000;

/** `@ai-sdk/mcp`'s transport, for a server the sandbox runs. */
export class SandboxStdioTransport implements MCPTransport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	readonly #port: LocalServerPort;
	readonly #command: LocalCommand;
	#input: WritableStreamDefaultWriter<Uint8Array> | null = null;
	#output: ReadableStreamDefaultReader<Uint8Array> | null = null;
	#closed = false;

	constructor(port: LocalServerPort, command: LocalCommand) {
		this.#port = port;
		this.#command = command;
	}

	async start(): Promise<void> {
		if (this.#input) throw new Error("The transport has started already");
		// A byte stream, which RPC carries to the sandbox as the command's input.
		const { readable, writable } = new IdentityTransformStream();
		this.#input = writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
		let output: ReadableStream<Uint8Array>;
		try {
			output = await this.#port.startMcpServer(this.#command, readable);
		} catch (error) {
			console.error("A local MCP server did not start", error);
			throw new LocalServerError(
				"The sandbox could not start its command. Try again in a few minutes",
			);
		}
		this.#output = output.getReader();
		void this.#read(this.#output);
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.#input || this.#closed) throw new Error("The server is not running");
		await this.#input.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// Its input ending is what stops the command.
		await this.#input?.close().catch(() => {});
		await this.#output?.cancel().catch(() => {});
		this.onclose?.();
	}

	async #read(output: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			for (;;) {
				const { done, value } = await output.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				let end = buffered.indexOf("\n");
				while (end !== -1) {
					this.#receive(buffered.slice(0, end));
					buffered = buffered.slice(end + 1);
					end = buffered.indexOf("\n");
				}
				if (buffered.length > MAX_MESSAGE_BYTES) {
					throw new Error("The server wrote a message too large to read");
				}
			}
		} catch (error) {
			if (!this.#closed) this.onerror?.(error instanceof Error ? error : new Error(String(error)));
		}
		if (!this.#closed) {
			this.#closed = true;
			this.onclose?.();
		}
	}

	#receive(line: string): void {
		const text = line.trim();
		if (text === "") return;
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch {
			// Servers are not to write anything else there, but some log a line on starting.
			return;
		}
		if (typeof message === "object" && message !== null && "jsonrpc" in message) {
			this.onmessage?.(message as JSONRPCMessage);
		}
	}
}
