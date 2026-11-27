import {
	OUTSIDE_TASK_TEXT_MAX,
	RUN_STATUSES,
	type RunStatus,
	rankWikiPages,
	WIKI_PAGE_NUMBER,
	type WikiPage,
	wikiContentsText,
	wikiNotFoundText,
	wikiPageText,
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

/** What one outside task came to: its run begun, or why not. */
export interface TaskStart {
	status: "started" | "duplicate" | "starting" | "limited" | "refused";
	runId?: string | null;
	conversationId?: string;
	retryAfter?: number;
	message?: string;
}

/** What one run came to: its state, its answer once it has one, and its page. */
export interface TaskRun {
	status: "ok" | "refused";
	message?: string;
	run?: {
		runId: string;
		state: RunStatus;
		error: string | null;
		agent: string;
		steps: number;
		inputTokens: number;
		outputTokens: number;
		/** Estimated cost in millionths of a dollar; null when a model it used has no prices. */
		cost: number | null;
		startedAt: number;
		endedAt: number | null;
		answer: string | null;
		conversationId: string | null;
		link: string;
	};
}

/** What the tools may do for one signed-in user. */
export interface AgentsAccess {
	workspaces(): Promise<{ slug: string; name: string; role: MemberRole }[]>;
	/**
	 * The repositories named `repoName` in the person's workspaces, or in the one with the slug
	 * `workspace` if they belong to it. A workspace they are not in matches nothing.
	 */
	wikis(repoName: string, workspace: string | undefined): Promise<WikiMatch[]>;
	/** Every repository with a wiki in the person's workspaces, or in the one named. */
	wikiRepos(workspace: string | undefined): Promise<WikiRepo[]>;
	/**
	 * Hands an agent of the workspace `workspace` the task `task` (`run_agent`, AGT-155): admitted
	 * and begun the way a trigger's delivery is, and counted like its run. `requestId` is the
	 * caller's own id for the task, so its retry finds the run instead of starting another.
	 */
	startTask(input: {
		workspace: string;
		agent: string;
		task: string;
		requestId: string;
	}): Promise<TaskStart>;
	/**
	 * Reads one run of the workspace `workspace` (`get_run`, AGT-155): its state and answer, as
	 * the Runs pages show them to the person. A run the person may not see is refused as if it
	 * did not exist.
	 */
	runOf(input: { workspace: string; runId: string }): Promise<TaskRun>;
}

/** A repository with a wiki, as list_wiki_repos lists it. */
export interface WikiRepo {
	workspace: string;
	repoName: string;
	private: boolean;
	pages: number;
	commit: string | null;
	writtenAt: number | null;
}

/** How much of the pages' text one answer to a question holds, in characters. */
export const ASK_TEXT_BUDGET = 40_000;

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
 * ask_wiki_question's answer, from the pages alone: those that bear on the question, whole, as many
 * as fit in `budget`, then the names of the others worth reading. DeepWiki has a model of its own
 * write the answer. Here the caller is an AI agent with a model, which answers from these pages,
 * so a question costs the workspace nothing and the answer is the caller's to word.
 */
export function wikiAnswerText(
	question: string,
	wikis: readonly { repoName: string; pages: readonly WikiPage[] }[],
	budget = ASK_TEXT_BUDGET,
): string {
	const several = wikis.length > 1;
	const names = wikis.map((wiki) => wiki.repoName).join(", ");
	const ranked = rankWikiPages(
		question,
		wikis.flatMap((wiki) => wiki.pages.map((page) => ({ ...page, repoName: wiki.repoName }))),
	);
	if (ranked.length === 0) {
		return [
			`No page of the wiki of ${names} uses the words of the question. Its pages, to read with read_wiki_contents:`,
			...wikis.map((wiki) => wikiStructureText(wiki.repoName, wiki.pages)),
		].join("\n\n");
	}
	const shown: string[] = [];
	let used = 0;
	for (const page of ranked) {
		const whole = `${several ? `Repository: ${page.repoName}\n\n` : ""}${wikiPageText(page)}`;
		if (shown.length > 0 && used + whole.length > budget) break;
		const room = budget - used;
		const kept =
			whole.length > room
				? `${whole.slice(0, room)}\n\n(Cut here: read_wiki_contents with page "${page.number}" gives the rest.)`
				: whole;
		shown.push(kept);
		used += kept.length;
	}
	const others = ranked.slice(shown.length, shown.length + 5);
	return [
		`From the wiki of ${names}, the pages that bear on the question, best first. Answer from them, citing their sources.`,
		shown.join("\n\n---\n\n"),
		others.length > 0
			? `Other pages that may help, to read with read_wiki_contents:\n${others
					.map((page) => `- ${page.number} ${page.title}${several ? ` (${page.repoName})` : ""}`)
					.join("\n")}`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** list_wiki_repos's answer. */
export function wikiReposText(repos: readonly WikiRepo[]): string {
	if (repos.length === 0) {
		return "No repository in your workspaces has a wiki yet. An owner or admin can have one written on a workspace's Wiki page in Gateweave Agents.";
	}
	const lines = repos.map((repo) => {
		const where = `workspace ${repo.workspace}${repo.private ? ", private" : ""}`;
		const commit = repo.commit ? `, at commit ${repo.commit.slice(0, 7)}` : "";
		const written = repo.writtenAt
			? `, written ${new Date(repo.writtenAt).toISOString().slice(0, 10)}`
			: "";
		return `- ${repo.repoName} (${where}): ${repo.pages} pages${commit}${written}`;
	});
	return `Repositories with a wiki:\n\n${lines.join("\n")}`;
}

/**
 * The server one request talks to, made for the person it acts as. Every tool reaches Agents
 * through `access` alone. `canRun` is whether the token carries `agents:run` (AGT-155): without
 * it the server offers the read tools alone, so a read-only token cannot even see `run_agent`.
 */
export function createAgentsServer(access: AgentsAccess, canRun = false): McpServer {
	const server = new McpServer({ name: "gateweave-agents", version: "1.0.0" });

	if (canRun) {
		server.registerTool(
			"run_agent",
			{
				title: "Give an agent a task",
				description:
					"Gives an agent of one of your workspaces a task and starts its run, the way a trigger would. The agent must have allowed tasks from outside (\"Tasks from MCP clients\" on its page), and the run spends the workspace's budget. The answer names the run and its conversation, which is in your chat list, where the run's state and answer can be read.",
				inputSchema: z.object({
					workspace: z
						.string()
						.min(1)
						.max(100)
						.describe("The workspace's slug, from list_workspaces."),
					agent: z
						.string()
						.min(1)
						.max(200)
						.describe("The agent's id or exact name, as its page in Gateweave Agents shows it."),
					task: z
						.string()
						.trim()
						.min(1)
						.max(OUTSIDE_TASK_TEXT_MAX)
						.describe(
							"What the agent should do, in full: it sees this text and nothing else of the ask.",
						),
					requestId: z
						.string()
						.regex(/^[\w-]{1,64}$/)
						.describe(
							"Your own id for this task. Send the same id on a retry, and the same run answers instead of a second one starting.",
						),
				}),
				outputSchema: z.looseObject({
					status: z.enum(["started", "duplicate", "starting", "limited", "refused"]),
					runId: z.string().nullable().optional(),
					conversationId: z.string().optional(),
					retryAfter: z.number().optional(),
					message: z.string().optional(),
				}),
				annotations: { readOnlyHint: false, openWorldHint: true },
			},
			async ({ workspace, agent, task, requestId }) => {
				const result = await access.startTask({ workspace, agent, task, requestId });
				const ok = result.status === "started" || result.status === "duplicate";
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					structuredContent: result,
					...(ok ? {} : { isError: true }),
				};
			},
		);

		server.registerTool(
			"get_run",
			{
				title: "Read a run",
				description:
					"Reads a run of one of your workspaces: its state, the agent's answer once it has one, its steps and tokens, and its link on the Runs page. A run another member started is an owner's or admin's to read.",
				inputSchema: z.object({
					workspace: z
						.string()
						.min(1)
						.max(100)
						.describe("The workspace's slug, from list_workspaces."),
					runId: z.string().min(1).max(64).describe("The run's id, as run_agent answered it."),
				}),
				outputSchema: z.looseObject({
					status: z.enum(["ok", "refused"]),
					message: z.string().optional(),
					run: z
						.looseObject({
							runId: z.string(),
							state: z.enum(RUN_STATUSES),
							error: z.string().nullable(),
							agent: z.string(),
							steps: z.number(),
							inputTokens: z.number(),
							outputTokens: z.number(),
							cost: z.number().nullable(),
							startedAt: z.number(),
							endedAt: z.number().nullable(),
							answer: z.string().nullable(),
							conversationId: z.string().nullable(),
							link: z.string(),
						})
						.optional(),
				}),
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async ({ workspace, runId }) => {
				const result = await access.runOf({ workspace, runId });
				const ok = result.status === "ok";
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					structuredContent: result,
					...(ok ? {} : { isError: true }),
				};
			},
		);
	}

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
				"Gives a repository's wiki in one of your workspaces: every page, or the one asked for, each headed by its number, with the source files it was written from and citations of their lines.",
			inputSchema: wikiInput.extend({
				page: z
					.string()
					.regex(WIKI_PAGE_NUMBER)
					.optional()
					.describe(
						'One page\'s number, as its heading or read_wiki_structure shows it, such as "2.1", to read only it.',
					),
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

	server.registerTool(
		"ask_wiki_question",
		{
			title: "Ask a wiki",
			description:
				"Finds the pages of a repository's wiki, or of up to 10 repositories' wikis, that bear on a question, and gives them, best first, for you to answer from. No model answers on the server: you read the pages and answer, citing their sources.",
			inputSchema: z.object({
				repoName: z
					.union([wikiInput.shape.repoName, z.array(wikiInput.shape.repoName).min(1).max(10)])
					.describe(
						'The repository as owner/name (e.g. "acme/app"), or a list of up to 10. For GitLab, its full path.',
					),
				question: z.string().trim().min(1).max(2000).describe("The question about the code."),
				workspace: wikiInput.shape.workspace,
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ repoName, question, workspace }) => {
			const names = [...new Set(Array.isArray(repoName) ? repoName : [repoName])];
			const chosen = await Promise.all(
				names.map(async (name) => chosenWiki(name, await access.wikis(name, workspace))),
			);
			const wikis = chosen.filter(
				(wiki): wiki is { repoName: string; pages: WikiPage[] } => !("problem" in wiki),
			);
			const problems = chosen.flatMap((wiki) => ("problem" in wiki ? [wiki.problem] : []));
			if (wikis.length === 0) return text(problems.join("\n"), true);
			const answer = wikiAnswerText(question, wikis);
			return text(problems.length > 0 ? `${answer}\n\nNot read:\n${problems.join("\n")}` : answer);
		},
	);

	server.registerTool(
		"list_wiki_repos",
		{
			title: "List wikis",
			description:
				"Lists the repositories that have a wiki in your workspaces, or in the one named, with how many pages each has and the commit it was written from.",
			inputSchema: z.object({ workspace: wikiInput.shape.workspace }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ workspace }) => text(wikiReposText(await access.wikiRepos(workspace))),
	);

	return server;
}
