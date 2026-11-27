import { env } from "cloudflare:workers";
import { createMCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ENGINE_TOOLS_URL, serveEngineTools } from "../src/engine-tools";
import { connectTools } from "../src/tools";
import type { RunRecorder } from "../src/trace";
import { type CallResult, FakeMcpServer } from "./fake-mcp";
import { answer, finding, MERGE_BASE, setup as reviewSetup } from "./review-fixture";
import { anthropicStream, fakeModel } from "./support";

const LIMIT = 16 * 1024;
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const definition = {
	name: "search",
	description: "Search",
	inputSchema: { type: "object" as const, properties: {} },
};

afterEach(() => vi.restoreAllMocks());

async function connected(result: CallResult) {
	const server = new FakeMcpServer([definition], () => result);
	fakeModel(() => anthropicStream("unused"), { "mcp.acme.dev": server.handle });
	const ended: { outputBytes?: number; error?: string | null }[] = [];
	const run = {
		serverConnecting: () => "server",
		serverConnected: () => {},
		targets: { tainted: false },
		toolStarted: () => "tool",
		toolEnded: (_span: string, details: { outputBytes?: number; error?: string | null }) => {
			ended.push(details);
		},
	} as unknown as RunRecorder;
	const toolbox = await connectTools(
		[
			{
				name: "acme",
				transport: "http",
				url: "https://mcp.acme.dev/mcp",
				headers: {},
				tools: null,
			},
		],
		run,
	);
	const call = async () =>
		await toolbox.tools.acme__search?.execute?.(
			{},
			{ toolCallId: "call", messages: [], context: undefined },
		);
	return { call, toolbox, ended };
}

describe("connected MCP result budget", () => {
	it("passes small structured results, metadata and content through intact", async () => {
		const original: CallResult = {
			content: [
				{ type: "text", text: "summary" },
				{ type: "image", data: "YWJj", mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file:///note", text: "note" } },
			],
			structuredContent: { count: 2 },
			_meta: { source: "test" },
			isError: false,
		};
		const { call, toolbox, ended } = await connected(original);
		try {
			expect(await call()).toEqual(original);
			expect(ended).toEqual([{ outputBytes: size(original), error: null }]);
		} finally {
			await toolbox.close();
		}
	});

	it("fits escaped multilingual text exactly inside the serialized limit", async () => {
		const original = {
			content: [{ type: "text" as const, text: '42 😀 café 中文 "\\\n'.repeat(3000) }],
			structuredContent: { count: 42 },
		};
		const { call, toolbox, ended } = await connected(original);
		try {
			const result = (await call()) as { content: { type: string; text: string }[] };
			expect(size(result)).toBeLessThanOrEqual(LIMIT);
			expect(size(result)).toBeGreaterThan(LIMIT - 136);
			expect(result.content[0]?.text).toContain(`${ended[0]?.outputBytes} bytes`);
			expect(result.content[0]?.text).toContain("Ask for less data");
			const prefix = result.content[1]?.text ?? "";
			expect(original.content[0]?.text.startsWith(prefix)).toBe(true);
			expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/u);
			expect(ended).toEqual([{ outputBytes: size({ ...original, isError: false }), error: null }]);
		} finally {
			await toolbox.close();
		}
	});

	it("omits oversized binary and structured data, preserving an MCP error", async () => {
		const original: CallResult = {
			content: [{ type: "image", data: "Y".repeat(40_000), mimeType: "image/png" }],
			structuredContent: { private: "Z".repeat(40_000) },
			isError: true,
		};
		const { call, toolbox, ended } = await connected(original);
		try {
			const result = await call();
			expect(size(result)).toBeLessThanOrEqual(LIMIT);
			expect(result).toMatchObject({ isError: true, content: [{ type: "text" }] });
			expect(JSON.stringify(result)).not.toContain("YYYY");
			expect(JSON.stringify(result)).not.toContain("ZZZZ");
			expect(ended).toEqual([
				{
					outputBytes: size({ ...original, isError: true }),
					error: "The tool answered with an error",
				},
			]);
		} finally {
			await toolbox.close();
		}
	});

	it("does not expose a sliced JSON snippet for structured-only results", async () => {
		const original = { structuredContent: { records: ["private".repeat(5000)] } };
		const { call, toolbox } = await connected(original);
		try {
			const result = (await call()) as { content: { type: string; text: string }[] };
			expect(result.content).toHaveLength(1);
			expect(result.content[0]?.text).toContain("Ask for less data");
			expect(JSON.stringify(result)).not.toContain("private");
			expect(size(result)).toBeLessThanOrEqual(LIMIT);
		} finally {
			await toolbox.close();
		}
	});

	it("leaves a tool with no local execute out of the engine's catalog", async () => {
		const client = await createMCPClient({
			transport: {
				type: "http",
				url: ENGINE_TOOLS_URL,
				fetch: (input, init) =>
					serveEngineTools(
						{
							provider: tool({ inputSchema: z.object({}) }),
							local: tool({ inputSchema: z.object({}), execute: async () => "done" }),
						},
						new Request(input, { ...init, redirect: "manual" }),
						new AbortController().signal,
					),
			},
		});
		try {
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["local"]);
		} finally {
			await client.close();
		}
	});

	it("serves the same capped result to a CLI through its MCP endpoint", async () => {
		const original: CallResult = { content: [{ type: "text", text: "A".repeat(30_000) }] };
		const { toolbox } = await connected(original);
		const client = await createMCPClient({
			transport: {
				type: "http",
				url: ENGINE_TOOLS_URL,
				fetch: (input, init) =>
					serveEngineTools(
						toolbox.tools,
						new Request(input, { ...init, redirect: "manual" }),
						new AbortController().signal,
					),
			},
		});
		try {
			const result = (await client.callTool({ name: "acme__search", arguments: {} })) as {
				content?: { type: string; text?: string }[];
			};
			expect(size(result)).toBeLessThanOrEqual(LIMIT);
			expect(result.content?.[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("bytes"),
			});
			expect(result.content?.[1]).toMatchObject({
				type: "text",
				text: expect.stringContaining("AAA"),
			});
		} finally {
			await client.close();
			await toolbox.close();
		}
	});
});

it("lists submit_review and returns the tool's proof over MCP", async () => {
	const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
	await sandbox.answerGit([{ match: ["merge-base"], answer: answer(MERGE_BASE) }]);
	const { tools } = reviewSetup(sandbox);
	const client = await createMCPClient({
		transport: {
			type: "http",
			url: ENGINE_TOOLS_URL,
			fetch: (input, init) =>
				serveEngineTools(
					tools,
					new Request(input, { ...init, redirect: "manual" }),
					new AbortController().signal,
				),
		},
	});
	try {
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["submit_review"]);
		const result = await client.callTool({
			name: "submit_review",
			arguments: { findings: [{ ...finding, proven: true }] },
		});
		expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
		const content = result.content as { type: string; text: string }[];
		expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({
			findings: [{ proof: { proven: false, exitCode: 0 } }],
		});
	} finally {
		await client.close();
	}
});
