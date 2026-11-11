import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { type AgentsAccess, createAgentsServer, type WikiMatch } from "./tools";

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
		wikis: async () => [],
	});

	const { tools } = await client.listTools();
	expect(tools.map((tool) => tool.name)).toEqual([
		"list_workspaces",
		"read_wiki_structure",
		"read_wiki_contents",
	]);
	for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);

	const result = await client.callTool({ name: "list_workspaces", arguments: {} });
	expect(result.structuredContent).toEqual({
		workspaces: [{ slug: "acme", name: "Acme", role: "owner" }],
	});
	await client.close();
});

const page = (number: string, title: string, depth: number, body: string) => ({
	number,
	title,
	depth,
	purpose: title,
	commit: "c".repeat(40),
	sources: [{ path: "src/sync.ts", lines: 10 }],
	body,
});

const written: WikiMatch = {
	workspace: "acme",
	repoName: "acme/app",
	pages: [
		page("1", "Overview", 0, "It syncs."),
		page("1.1", "Sync", 1, "Ops.\n\n**Sources:** [src/sync.ts:1-3]()"),
	],
};

/** Calls a tool with access that finds `matches`, and keeps what the tool asked access for. */
async function call(matches: WikiMatch[], name: string, args: Record<string, unknown>) {
	const asked: unknown[] = [];
	const client = await connect({
		workspaces: async () => [],
		wikis: async (...query) => {
			asked.push(query);
			return matches;
		},
	});
	const result = await client.callTool({ name, arguments: args });
	await client.close();
	const [content] = result.content as { type: string; text: string }[];
	return { text: content?.text ?? "", isError: result.isError === true, asked };
}

describe("the wiki tools, as DeepWiki's", () => {
	it("lists a wiki's pages", async () => {
		const answer = await call([written], "read_wiki_structure", { repoName: "acme/app" });
		expect(answer).toEqual({
			text: "Available pages for acme/app:\n\n- 1 Overview\n  - 1.1 Sync",
			isError: false,
			asked: [["acme/app", undefined]],
		});
	});

	it("gives every page, or the one asked for", async () => {
		const all = await call([written], "read_wiki_contents", { repoName: "acme/app" });
		expect(all.text.split("\n\n---\n\n")).toHaveLength(2);
		expect(all.text).toContain("# Page: Overview");

		const one = await call([written], "read_wiki_contents", { repoName: "acme/app", page: "1.1" });
		expect(one.text).toMatch(/^# Page: Sync\n/);
		expect(one.text).not.toContain("Overview");

		const missing = await call([written], "read_wiki_contents", {
			repoName: "acme/app",
			page: "9",
		});
		expect(missing).toMatchObject({ isError: true, text: expect.stringMatching(/no page 9/) });
	});

	it("says a repository is not there as DeepWiki does", async () => {
		const answer = await call([], "read_wiki_contents", {
			repoName: "acme/gone",
			workspace: "acme",
		});
		expect(answer).toEqual({
			text: "Error fetching wiki for acme/gone: Repository not found.",
			isError: true,
			asked: [["acme/gone", "acme"]],
		});
	});

	it("tells a repository without a wiki from a missing one", async () => {
		const answer = await call([{ ...written, pages: null }], "read_wiki_structure", {
			repoName: "acme/app",
		});
		expect(answer).toMatchObject({ isError: true, text: expect.stringMatching(/has no wiki yet/) });
	});

	it("reads the one workspace's wiki that is written, and asks which when two are", async () => {
		const unwritten = { ...written, workspace: "other", pages: null };
		const one = await call([unwritten, written], "read_wiki_structure", { repoName: "acme/app" });
		expect(one.isError).toBe(false);

		const both = await call([written, { ...written, workspace: "other" }], "read_wiki_structure", {
			repoName: "acme/app",
		});
		expect(both).toMatchObject({ isError: true, text: expect.stringMatching(/acme, other/) });
	});
});
