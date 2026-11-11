import {
	type WikiPage,
	wikiContentsText,
	wikiNotFoundText,
	wikiStructureText,
} from "@gateweave/agents-model";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MEMBER_ROLES, type MemberRole } from "#/lib/roles";

// Agents' MCP tools. They only reach Agents through AgentsAccess, which offers what the signed-in
// user can see, and nothing more. Free of `cloudflare:workers` imports so the tools can be tested
// in Node.

/** A repository of that name in one of the person's workspaces, with its wiki if it has one. */
export interface WikiMatch {
	workspace: string;
	repoName: string;
	pages: WikiPage[] | null;
}

/** What the tools may do for one signed-in user. */
export interface AgentsAccess {
	workspaces(): Promise<{ slug: string; name: string; role: MemberRole }[]>;
	/**
	 * The repositories named `repoName` in the person's workspaces, or in the one with the slug
	 * `workspace` if they belong to it. A workspace they are not in matches nothing.
	 */
	wikis(repoName: string, workspace: string | undefined): Promise<WikiMatch[]>;
}

/** Wraps a tool's result as structured content, with the same data as text for clients without it. */
async function run<Result extends Record<string, unknown>>(
	work: () => Promise<Result>,
): Promise<CallToolResult> {
	const result = await work();
	return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

/** A wiki tool's answer: text alone, as DeepWiki's tools give it. */
function text(value: string, isError = false): CallToolResult {
	return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

const PAGE_NUMBER = /^\d{1,2}(\.\d{1,2}){0,4}$/;

// DeepWiki's tools take `repoName` alone. An Agents server holds many workspaces, so `workspace`
// is there for the rare repository in more than one of the person's, and is otherwise left out.
const wikiInput = z.object({
	repoName: z
		.string()
		.trim()
		.min(3)
		.max(300)
		.describe(
			'The repository, as owner/name (e.g. "acme/app"). For GitLab, its full path, such as "group/subgroup/app".',
		),
	workspace: z
		.string()
		.min(1)
		.max(100)
		.optional()
		.describe(
			"The workspace's slug, from list_workspaces. Needed only when more than one of your workspaces has the repository.",
		),
});

/**
 * The wiki a call means: the one match that has a wiki, or why there is none. A repository whose
 * wiki is not written yet is told apart from one that is not there, which a member may know of
 * anyway, as they see the repository on its pages.
 */
function chosenWiki(
	repoName: string,
	matches: WikiMatch[],
): { repoName: string; pages: WikiPage[] } | { problem: string } {
	const written = matches.filter(
		(match): match is WikiMatch & { pages: WikiPage[] } => match.pages !== null,
	);
	const [only] = written;
	if (only && written.length === 1) return { repoName: only.repoName, pages: only.pages };
	if (written.length > 1) {
		const slugs = written.map((match) => match.workspace).join(", ");
		return {
			problem: `${repoName} has a wiki in more than one of your workspaces (${slugs}). Name one with workspace.`,
		};
	}
	if (matches.length > 0) {
		return {
			problem: `${repoName} has no wiki yet. An owner or admin of the workspace can have one written on its Wiki page in Gateweave Agents.`,
		};
	}
	return { problem: wikiNotFoundText(repoName) };
}

/**
 * The server one request talks to, made for the person it acts as. Every tool reaches Agents
 * through `access` alone.
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

	// The wiki tools have DeepWiki's names, arguments and answers, so an agent set up for DeepWiki's
	// or Devin's MCP server reads a workspace's wikis unchanged.
	server.registerTool(
		"read_wiki_structure",
		{
			title: "Read a wiki's pages",
			description:
				"Lists the pages of a repository's wiki, numbered, in one of your workspaces. Read them with read_wiki_contents.",
			inputSchema: wikiInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ repoName, workspace }) => {
			const wiki = chosenWiki(repoName, await access.wikis(repoName, workspace));
			if ("problem" in wiki) return text(wiki.problem, true);
			return text(wikiStructureText(wiki.repoName, wiki.pages));
		},
	);

	server.registerTool(
		"read_wiki_contents",
		{
			title: "Read a wiki",
			description:
				"Gives a repository's wiki in one of your workspaces: every page, or the one asked for, each with the source files it was written from and citations of their lines.",
			inputSchema: wikiInput.extend({
				page: z
					.string()
					.regex(PAGE_NUMBER)
					.optional()
					.describe('One page\'s number from read_wiki_structure, such as "2.1", to read only it.'),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ repoName, workspace, page }) => {
			const wiki = chosenWiki(repoName, await access.wikis(repoName, workspace));
			if ("problem" in wiki) return text(wiki.problem, true);
			if (page === undefined) return text(wikiContentsText(wiki.pages));
			const asked = wiki.pages.find((candidate) => candidate.number === page);
			if (!asked) {
				return text(
					`${wiki.repoName}'s wiki has no page ${page}. read_wiki_structure lists its pages.`,
					true,
				);
			}
			return text(wikiContentsText([asked]));
		},
	);

	return server;
}
