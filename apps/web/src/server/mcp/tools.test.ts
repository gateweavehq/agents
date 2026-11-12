import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
	type AgentsAccess,
	createAgentsServer,
	type WikiMatch,
	type WikiRepo,
	wikiAnswerText,
} from "./tools";

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
		wikiRepos: async () => [],
	});

	const { tools } = await client.listTools();
	expect(tools.map((tool) => tool.name)).toEqual([
		"list_workspaces",
		"read_wiki_structure",
		"read_wiki_contents",
		"ask_wiki_question",
		"list_wiki_repos",
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
async function call(
	matches: WikiMatch[] | ((repoName: string) => WikiMatch[]),
	name: string,
	args: Record<string, unknown>,
	repos: WikiRepo[] = [],
) {
	const asked: unknown[] = [];
	const client = await connect({
		workspaces: async () => [],
		wikis: async (...query) => {
			asked.push(query);
			return typeof matches === "function" ? matches(query[0]) : matches;
		},
		wikiRepos: async (workspace) => {
			asked.push([workspace]);
			return repos;
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

describe("asking a wiki", () => {
	const store: WikiMatch = {
		workspace: "acme",
		repoName: "acme/store",
		pages: [page("1", "Storage", 0, "Rows live in SQLite.\n\n**Sources:** [src/db.ts:1-9]()")],
	};

	it("gives the pages that bear on the question, best first, with no model", async () => {
		const answer = await call([written], "ask_wiki_question", {
			repoName: "acme/app",
			question: "How does it sync the ops?",
		});
		expect(answer.isError).toBe(false);
		expect(answer.text).toMatch(/^From the wiki of acme\/app, the pages that bear on the question/);
		// "sync" is in the Sync page's title and the Overview's text: Sync comes first, then Overview.
		expect(answer.text.indexOf("# Page: Sync")).toBeLessThan(
			answer.text.indexOf("# Page: Overview"),
		);
		expect(answer.text).toContain("[src/sync.ts:1-3]()");
	});

	it("reads several repositories, and says which it could not", async () => {
		const answer = await call(
			(repoName) =>
				repoName === "acme/store" ? [store] : repoName === "acme/app" ? [written] : [],
			"ask_wiki_question",
			{
				repoName: ["acme/app", "acme/store", "acme/gone"],
				question: "Where do rows live in SQLite?",
			},
		);
		expect(answer.isError).toBe(false);
		expect(answer.text).toContain("Repository: acme/store\n\n# Page: Storage");
		expect(answer.text).not.toContain("# Page: Sync");
		expect(answer.text).toMatch(
			/Not read:\nError fetching wiki for acme\/gone: Repository not found\.$/,
		);
	});

	it("lists the pages when none uses the question's words", async () => {
		const answer = await call([written], "ask_wiki_question", {
			repoName: "acme/app",
			question: "What about billing?",
		});
		expect(answer.text).toContain("No page of the wiki of acme/app uses the words of the question");
		expect(answer.text).toContain("Available pages for acme/app:");
	});

	it("keeps to its budget, cutting the first page if it must and naming the rest", () => {
		const long = page("2", "Sync engine", 0, `sync ${"x".repeat(5000)}`);
		const other = page("3", "Sync tests", 0, "sync");
		const text = wikiAnswerText("sync", [{ repoName: "acme/app", pages: [long, other] }], 1000);
		expect(text).toContain('(Cut here: read_wiki_contents with page "2" gives the rest.)');
		expect(text).toContain(
			"Other pages that may help, to read with read_wiki_contents:\n- 3 Sync tests",
		);
		expect(text.length).toBeLessThan(1500);
	});

	it("fails only when no repository asked about has a wiki", async () => {
		const answer = await call([], "ask_wiki_question", {
			repoName: "acme/gone",
			question: "Sync?",
		});
		expect(answer).toMatchObject({ isError: true, text: wikiNotFound("acme/gone") });
	});
});

function wikiNotFound(repoName: string) {
	return `Error fetching wiki for ${repoName}: Repository not found.`;
}

describe("listing wikis", () => {
	it("lists the repositories with a wiki in the person's workspaces", async () => {
		const answer = await call([], "list_wiki_repos", { workspace: "acme" }, [
			{
				workspace: "acme",
				repoName: "acme/app",
				private: true,
				pages: 12,
				commit: "abcdef1234567890",
				writtenAt: Date.UTC(2026, 10, 12),
			},
		]);
		expect(answer).toEqual({
			text: "Repositories with a wiki:\n\n- acme/app (workspace acme, private): 12 pages, at commit abcdef1, written 2026-11-12",
			isError: false,
			asked: [["acme"]],
		});
		const none = await call([], "list_wiki_repos", {});
		expect(none.text).toMatch(/^No repository in your workspaces has a wiki yet/);
	});
});
