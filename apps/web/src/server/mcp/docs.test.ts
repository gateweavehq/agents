import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { connect } from "./test-client";
import type { AgentsAccess } from "./tools";

const PAGE = resolve(import.meta.dirname, "../../../../../docs/mcp.md");
const START = "<!-- mcp-tools:start -->";
const END = "<!-- mcp-tools:end -->";
const REWRITE = "UPDATE_MCP_DOCS=1 pnpm --filter @gateweave/agents-web exec vitest run mcp/docs";

/**
 * What each tool needs of a token and of the workspace, in the words of docs/mcp.md. The server
 * does not describe this in its tools/list, so it is kept here, by tool name: a tool without an
 * entry fails the test below, so none ships undocumented.
 */
const NEEDS: Record<string, string> = {
	list_workspaces: "`agents`",
	read_wiki_structure: "`agents`",
	read_wiki_contents: "`agents`",
	ask_wiki_question: "`agents`",
	list_wiki_repos: "`agents`",
	run_agent: '`agents:run`; the agent\'s "Tasks from MCP clients" setting turned on',
	get_run: "`agents:run`",
};

const NO_ACCESS: AgentsAccess = {
	workspaces: async () => [],
	wikis: async () => [],
	wikiRepos: async () => [],
	startTask: async () => ({ status: "refused" as const, message: "not in this test" }),
	runOf: async () => ({ status: "refused" as const, message: "not in this test" }),
};

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

async function toolsOffered(canRun: boolean): Promise<Listed[]> {
	const client = await connect(NO_ACCESS, canRun);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

/** Every tool the server can register, under either value of `canRun`, in the order offered. */
async function allTools(): Promise<Listed[]> {
	const byName = new Map<string, Listed>();
	for (const canRun of [false, true]) {
		for (const tool of await toolsOffered(canRun)) {
			if (!byName.has(tool.name)) byName.set(tool.name, tool);
		}
	}
	return [...byName.values()];
}

const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

function firstSentence(description: string | undefined): string {
	const text = (description ?? "").trim();
	return /^.+?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;
}

function inputOf(tool: Listed): string {
	const required = new Set(tool.inputSchema.required ?? []);
	const names = Object.keys(tool.inputSchema.properties ?? {});
	return names.length === 0
		? "none"
		: names.map((name) => `\`${name}${required.has(name) ? "" : "?"}\``).join(", ");
}

function outputOf(tool: Listed): string {
	// Without an outputSchema a tool answers in text alone.
	if (!tool.outputSchema) return "text";
	const names = Object.keys(tool.outputSchema.properties ?? {});
	return names.length === 0 ? "text" : names.map((name) => `\`${name}\``).join(", ");
}

/** Padded the way Biome formats Markdown tables, so `pnpm check` leaves the generated block alone. */
function renderTable(tools: Listed[]): string {
	const rows = [
		["Tool", "What it does", "Input", "Output", "Needs"],
		...tools.map((tool) =>
			[
				`\`${tool.name}\``,
				firstSentence(tool.description),
				inputOf(tool),
				outputOf(tool),
				NEEDS[tool.name] ?? "",
			].map(cell),
		),
	];
	const widths = [0, 1, 2, 3, 4].map((column) =>
		Math.max(...rows.map((row) => row[column]?.length ?? 0)),
	);
	const line = (cells: string[]) =>
		`| ${cells.map((text, column) => text.padEnd(widths[column] ?? 0)).join(" | ")} |`;
	const [head = [], ...body] = rows;
	return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

it("has a needs entry for every tool the server can register, and none for a tool it cannot", async () => {
	const names = (await allTools()).map((tool) => tool.name);
	expect(names).toContain("run_agent");
	expect(names).toContain("list_workspaces");
	expect(names.filter((name) => !(name in NEEDS))).toEqual([]);
	expect(Object.keys(NEEDS).filter((name) => !names.includes(name))).toEqual([]);
});

it("keeps the tools table in docs/mcp.md as the server's tools/list renders it", async () => {
	const table = renderTable(await allTools());
	const page = readFileSync(PAGE, "utf8");
	const start = page.indexOf(START);
	const end = page.indexOf(END);
	expect(start, `docs/mcp.md has no ${START} line`).toBeGreaterThanOrEqual(0);
	expect(end, `docs/mcp.md has no ${END} line after it`).toBeGreaterThan(start);

	const block = `${START}\n${table}\n${END}`;
	const current = page.slice(start, end + END.length);
	if (process.env.UPDATE_MCP_DOCS === "1") {
		if (current !== block) {
			writeFileSync(PAGE, page.slice(0, start) + block + page.slice(end + END.length));
		}
		return;
	}
	expect(
		current,
		`The tools table in docs/mcp.md is out of date. Rewrite it with: ${REWRITE}`,
	).toBe(block);
});
