import { describe, expect, it } from "vitest";
import {
	checkCitations,
	numberWikiPages,
	parseWikiSteering,
	rankWikiPages,
	WIKI_MAX_DEPTH,
	WIKI_MAX_PAGE_LENGTH,
	WIKI_MAX_PAGES,
	WIKI_PAGE_NUMBER,
	wikiContentsText,
	wikiNotFoundText,
	wikiStructureText,
} from "../src";

describe(".devin/wiki.json", () => {
	const page = (title: string, parent?: string) => ({
		title,
		purpose: `What ${title} covers`,
		...(parent ? { parent } : {}),
	});

	it("reads a file DeepWiki would take", () => {
		const steering = parseWikiSteering(
			JSON.stringify({
				repo_notes: [{ content: "Read AGENTS.md first.", author: "Maintainers" }],
				pages: [page("Overview"), page("Layout", "Overview")],
			}),
		);
		expect(steering).toMatchObject({
			repo_notes: [{ content: "Read AGENTS.md first." }],
			pages: [{ title: "Overview" }, { title: "Layout", parent: "Overview" }],
		});
	});

	it("refuses what DeepWiki refuses, saying why", () => {
		const problem = (value: unknown) => {
			const parsed = parseWikiSteering(JSON.stringify(value));
			return "problem" in parsed ? parsed.problem : null;
		};
		expect(parseWikiSteering("{")).toEqual({ problem: ".devin/wiki.json is not JSON" });
		expect(problem({ repo_notes: [] })).toMatch(/pages/);
		expect(problem({ repo_notes: [], pages: [] })).toMatch(/pages/);
		expect(problem({ repo_notes: [], pages: [page("A"), page("A")] })).toMatch(
			/Two pages are called "A"/,
		);
		expect(problem({ repo_notes: [], pages: [page("A", "Nowhere")] })).toMatch(/not a page/);
		expect(problem({ repo_notes: [], pages: [page("A", "B"), page("B", "A")] })).toMatch(
			/each other's parents/,
		);
		const many = Array.from({ length: WIKI_MAX_PAGES + 1 }, (_, i) => page(`Page ${i}`));
		expect(problem({ repo_notes: [], pages: many })).toMatch(/pages/);
		const notes = Array.from({ length: 101 }, () => ({ content: "A note" }));
		expect(problem({ repo_notes: notes, pages: [page("A")] })).toMatch(/More than 100 notes/);
		expect(problem({ repo_notes: [{ content: "x".repeat(10_001) }], pages: [page("A")] })).toMatch(
			/repo_notes/,
		);
	});
});

describe("numbering", () => {
	it("numbers pages as DeepWiki does, children after their parent", () => {
		const numbered = numberWikiPages([
			{ title: "Overview", parent: null },
			{ title: "Sync", parent: null },
			{ title: "Setup", parent: "Overview" },
			{ title: "Oplog", parent: "Sync" },
			{ title: "Layout", parent: "Overview" },
		]);
		expect(numbered.map(({ number, page, depth }) => `${number} ${page.title} ${depth}`)).toEqual([
			"1 Overview 0",
			"1.1 Setup 1",
			"1.2 Layout 1",
			"2 Sync 0",
			"2.1 Oplog 1",
		]);
	});

	it("keeps a page whose parent is missing or circular, at the top", () => {
		const numbered = numberWikiPages([
			{ title: "A", parent: "B" },
			{ title: "B", parent: "A" },
			{ title: "C", parent: "Gone" },
		]);
		expect(numbered.map(({ number, page }) => `${number} ${page.title}`)).toEqual([
			"1 A",
			"2 B",
			"3 C",
		]);
	});

	it("nests pages no deeper than a page number reaches, so each can be opened", () => {
		const titles = ["A", "B", "C", "D", "E", "F", "G"];
		const numbered = numberWikiPages(
			titles.map((title, i) => ({ title, parent: i === 0 ? null : (titles[i - 1] ?? null) })),
		);
		expect(numbered.map(({ number, page }) => `${number} ${page.title}`)).toEqual([
			"1 A",
			"1.1 B",
			"1.1.1 C",
			"1.1.1.1 D",
			"1.1.1.1.1 E",
			"1.1.1.1.2 F",
			"1.1.1.1.3 G",
		]);
		for (const { number, depth } of numbered) {
			expect(number).toMatch(WIKI_PAGE_NUMBER);
			expect(depth).toBeLessThan(WIKI_MAX_DEPTH);
		}
	});
});

describe("citations", () => {
	const sources = [
		{ path: "src/sync.ts", lines: 120 },
		{ path: "README.md", lines: 10 },
	];

	it("keeps citations of lines a page read", () => {
		const body = "**Sources:** [src/sync.ts:12-30](), [README.md:3]()";
		expect(checkCitations(body, sources)).toBe(body);
	});

	it("turns the rest into the plain path", () => {
		expect(
			checkCitations(
				"[src/sync.ts:100-200]() [src/other.ts:1]() [README.md:0]() [README.md:9-4]()",
				sources,
			),
		).toBe("`src/sync.ts` `src/other.ts` `README.md` `README.md`");
	});

	it("reads a page of brackets in linear time", () => {
		const body = "[!".repeat(WIKI_MAX_PAGE_LENGTH / 2);
		const started = Date.now();
		expect(checkCitations(body, sources)).toBe(body);
		expect(Date.now() - started).toBeLessThan(500);
	});
});

describe("DeepWiki's answers", () => {
	it("lists the structure as read_wiki_structure does", () => {
		expect(
			wikiStructureText("acme/app", [
				{ number: "1", title: "Overview", depth: 0 },
				{ number: "1.1", title: "Installation and Setup", depth: 1 },
				{ number: "2", title: "Sync", depth: 0 },
			]),
		).toBe(
			"Available pages for acme/app:\n\n- 1 Overview\n  - 1.1 Installation and Setup\n- 2 Sync",
		);
	});

	it("gives every page as read_wiki_contents does", () => {
		const text = wikiContentsText([
			{ title: "Overview", sources: [{ path: "README.md", lines: 4 }], body: "It syncs.\n" },
			{ title: "Sync", sources: [], body: "Ops.\n\n**Sources:** [src/sync.ts:1-2]()" },
		]);
		const pages = text.split("\n\n---\n\n");
		expect(pages).toHaveLength(2);
		expect(pages[0]).toBe(
			"# Page: Overview\n\n<details>\n<summary>Relevant source files</summary>\n\nThe following files were used as context for generating this wiki page:\n\n- [README.md](README.md)\n\n</details>\n\n# Overview\n\nIt syncs.",
		);
		expect(pages[1]).toBe("# Page: Sync\n\n# Sync\n\nOps.\n\n**Sources:** [src/sync.ts:1-2]()");
	});

	it("says a repository has no wiki as DeepWiki does", () => {
		expect(wikiNotFoundText("acme/app")).toBe(
			"Error fetching wiki for acme/app: Repository not found.",
		);
	});
});

describe("finding the pages a question is about", () => {
	const page = (title: string, purpose: string, body: string) => ({ title, purpose, body });
	const pages = [
		page("Overview", "What the app is", "The app keeps a list and syncs it to every tab."),
		page("Sync engine", "How changes reach other tabs", "Each mutation gets the next version."),
		page("Storage", "Where rows live", "Rows live in SQLite, and every mutation is logged."),
		page("Deploying", "Shipping a release", "Run the deploy script."),
	];
	const titles = (question: string) => rankWikiPages(question, pages).map((found) => found.title);

	it("puts a page whose title has the question's words first", () => {
		expect(titles("How does syncing work?")).toEqual(["Sync engine", "Overview"]);
	});

	it("weighs a word few pages have above one most have", () => {
		// "mutation" is on two pages and "SQLite" on one, so Storage leads.
		expect(titles("Which mutations go to SQLite?")).toEqual(["Storage", "Sync engine"]);
	});

	it("counts a word in a page's purpose above one in its text", () => {
		expect(titles("Which mutations reach SQLite?")[0]).toBe("Sync engine");
	});

	it("finds nothing when no page has the question's words", () => {
		expect(titles("How does it do what it does?")).toEqual([]);
		expect(titles("Billing?")).toEqual([]);
	});
});
