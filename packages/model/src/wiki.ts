/**
 * A repository's wiki (AGT-108): pages a model writes about the code, which members read in the
 * app and agents read over MCP with the tools DeepWiki's server has. The text formats here are
 * DeepWiki's, as its server answers (checked 2026-11-11, "DeepWiki" 4.0.2), so an agent that reads
 * DeepWiki reads this wiki the same way.
 */
import { z } from "zod";
import { KEYED_PROVIDERS, type KeyedProvider, type RepositoryProvider } from "./vocabulary";

/** Where a repository steers its wiki: the file DeepWiki reads, so one file steers both. */
export const WIKI_STEERING_PATH = ".devin/wiki.json";

/** DeepWiki's limits on that file, which a wiki here keeps too. */
export const WIKI_MAX_PAGES = 30;
export const WIKI_MAX_NOTES = 100;
export const WIKI_MAX_NOTE_LENGTH = 10_000;

/** Files a writer reads for one page, chosen when the wiki is planned. */
export const WIKI_FILES_PER_PAGE = 12;

/** The longest page kept. A model that writes more is cut off, and the page says so. */
export const WIKI_MAX_PAGE_LENGTH = 60_000;

const note = z.object({
	content: z.string().trim().min(1).max(WIKI_MAX_NOTE_LENGTH),
	author: z.string().max(200).optional(),
});
export type WikiNote = z.infer<typeof note>;

const title = z.string().trim().min(1).max(200);

/**
 * `.devin/wiki.json`. With it, exactly its pages are written, in its order, under its parents.
 * DeepWiki refuses a file that breaks these rules, and so does this.
 */
export const wikiSteering = z
	.object({
		repo_notes: z.array(note),
		pages: z
			.array(
				z.object({
					title,
					purpose: z.string().trim().min(1).max(WIKI_MAX_NOTE_LENGTH),
					parent: title.optional(),
					page_notes: z.array(note).optional(),
				}),
			)
			.min(1)
			.max(WIKI_MAX_PAGES),
	})
	.superRefine((steering, context) => {
		const titles = new Set<string>();
		for (const page of steering.pages) {
			if (titles.has(page.title)) {
				context.addIssue({ code: "custom", message: `Two pages are called "${page.title}"` });
			}
			titles.add(page.title);
		}
		for (const page of steering.pages) {
			if (page.parent !== undefined && !titles.has(page.parent)) {
				context.addIssue({
					code: "custom",
					message: `"${page.title}" has the parent "${page.parent}", which is not a page`,
				});
			}
		}
		const notes =
			steering.repo_notes.length +
			steering.pages.reduce((sum, page) => sum + (page.page_notes?.length ?? 0), 0);
		if (notes > WIKI_MAX_NOTES) {
			context.addIssue({ code: "custom", message: `More than ${WIKI_MAX_NOTES} notes in all` });
		}
		if (hasCycle(steering.pages)) {
			context.addIssue({ code: "custom", message: "Some pages are each other's parents" });
		}
	});
export type WikiSteering = z.infer<typeof wikiSteering>;

/** Reads `.devin/wiki.json`, or says in one line why it cannot be used. */
export function parseWikiSteering(text: string): WikiSteering | { problem: string } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { problem: `${WIKI_STEERING_PATH} is not JSON` };
	}
	const parsed = wikiSteering.safeParse(json);
	if (parsed.success) return parsed.data;
	const issue = parsed.error.issues[0];
	const where = issue && issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
	return { problem: `${WIKI_STEERING_PATH} breaks a rule: ${issue?.message ?? "invalid"}${where}` };
}

function hasCycle(pages: readonly { title: string; parent?: string | undefined }[]): boolean {
	const parentOf = new Map(pages.map((page) => [page.title, page.parent]));
	for (const page of pages) {
		const seen = new Set<string>();
		let at: string | undefined = page.title;
		while (at !== undefined) {
			if (seen.has(at)) return true;
			seen.add(at);
			at = parentOf.get(at);
		}
	}
	return false;
}

/** A page as planned: what it covers, under which page, and the files its writer reads. */
export interface PlannedWikiPage {
	title: string;
	purpose: string;
	parent: string | null;
	notes: string[];
	files: string[];
}

/** A page placed in the wiki's tree: `number` is DeepWiki's, such as `2.1`. */
export interface NumberedWikiPage<T> {
	page: T;
	number: string;
	depth: number;
}

/**
 * The pages in reading order, numbered as DeepWiki numbers them: top-level pages 1, 2, 3 in their
 * order, and each page's children after it, 2.1, 2.2. A parent that is not a page, or that would
 * make a cycle, counts as none.
 */
export function numberWikiPages<T extends { title: string; parent: string | null }>(
	pages: readonly T[],
): NumberedWikiPage<T>[] {
	const byTitle = new Map(pages.map((page) => [page.title, page]));
	const parentOf = (page: T): string | null => {
		const { parent } = page;
		if (parent === null || !byTitle.has(parent)) return null;
		// Parents that lead back to the page would hide them all: break the cycle here.
		const seen = new Set([page.title]);
		let at: string | null = parent;
		while (at !== null) {
			if (seen.has(at)) return null;
			seen.add(at);
			const up: string | null = byTitle.get(at)?.parent ?? null;
			at = up !== null && byTitle.has(up) ? up : null;
		}
		return parent;
	};
	const children = new Map<string | null, T[]>();
	for (const page of pages) {
		const parent = parentOf(page);
		children.set(parent, [...(children.get(parent) ?? []), page]);
	}
	const ordered: NumberedWikiPage<T>[] = [];
	const visit = (parent: string | null, prefix: string, depth: number) => {
		(children.get(parent) ?? []).forEach((page, index) => {
			const number = `${prefix}${index + 1}`;
			ordered.push({ page, number, depth });
			visit(page.title, `${number}.`, depth + 1);
		});
	};
	visit(null, "", 0);
	return ordered;
}

/** A file a page drew on, as its "Relevant source files" lists it. */
export interface WikiSource {
	path: string;
	/** Lines in the file, when it was read. */
	lines: number | null;
}

/** A citation in a page's text: `[path:12-30]()`, DeepWiki's form, with an empty link. */
export const WIKI_CITATION = /\[([^\]\s:]+):(\d+)(?:-(\d+))?\]\(\)/g;

/**
 * Keeps the citations that name a file the page read and lines it has, and turns the rest into the
 * plain path, so a reader is never sent to lines that are not there.
 */
export function checkCitations(body: string, sources: readonly WikiSource[]): string {
	const lines = new Map(sources.map((source) => [source.path, source.lines]));
	return body.replace(WIKI_CITATION, (whole, path: string, from: string, to?: string) => {
		const count = lines.get(path);
		const start = Number(from);
		const end = to === undefined ? start : Number(to);
		const fits = count != null && start >= 1 && end >= start && end <= count;
		return fits ? whole : `\`${path}\``;
	});
}

/** `read_wiki_structure`'s answer. */
export function wikiStructureText(
	repoName: string,
	pages: readonly { number: string; title: string; depth: number }[],
): string {
	const lines = pages.map((page) => `${"  ".repeat(page.depth)}- ${page.number} ${page.title}`);
	return `Available pages for ${repoName}:\n\n${lines.join("\n")}`;
}

/** One page as `read_wiki_contents` gives it: its sources first, then its text. */
export function wikiPageText(page: {
	title: string;
	sources: readonly WikiSource[];
	body: string;
}): string {
	const sources = page.sources.map((source) => `- [${source.path}](${source.path})`).join("\n");
	const details =
		page.sources.length === 0
			? ""
			: `<details>\n<summary>Relevant source files</summary>\n\nThe following files were used as context for generating this wiki page:\n\n${sources}\n\n</details>\n\n`;
	return `# Page: ${page.title}\n\n${details}# ${page.title}\n\n${page.body.trim()}`;
}

/** `read_wiki_contents`'s answer: every page in reading order. */
export function wikiContentsText(pages: readonly Parameters<typeof wikiPageText>[0][]): string {
	return pages.map(wikiPageText).join("\n\n---\n\n");
}

/** What DeepWiki answers for a repository it has no wiki of. */
export function wikiNotFoundText(repoName: string): string {
	return `Error fetching wiki for ${repoName}: Repository not found.`;
}

/** What a member asks for when they have a wiki written: which model writes it. */
export const wikiStartInput = z.object({
	provider: z.enum(KEYED_PROVIDERS),
	model: z.string().trim().min(1).max(200),
});
export type WikiStartInput = z.infer<typeof wikiStartInput>;

export const WIKI_STATUSES = ["planning", "writing", "ready", "failed"] as const;
export type WikiStatus = (typeof WIKI_STATUSES)[number];

/** One writing of a repository's wiki, under way or done. */
export interface WikiGeneration {
	id: string;
	status: WikiStatus;
	/** The commit it read, once it has read one. */
	commit: string | null;
	/** Whether `.devin/wiki.json` decided its pages, and why not when the file was there. */
	steered: boolean;
	steeringProblem: string | null;
	provider: KeyedProvider;
	model: string;
	startedBy: string;
	startedAt: number;
	finishedAt: number | null;
	error: string | null;
	pagesTotal: number;
	pagesDone: number;
	tokens: { input: number; output: number };
	/** Millionths of a dollar at the provider's list prices; null for a model with no prices. */
	cost: number | null;
}

/** A repository and its wiki: the one people read, and the one being written. */
export interface WikiEntry {
	repositoryId: string;
	provider: RepositoryProvider;
	owner: string;
	name: string;
	private: boolean;
	live: WikiGeneration | null;
	/** Being written, or the last try that failed after the live one. */
	latest: WikiGeneration | null;
}

/** A page in the tree, for the wiki's table of contents. */
export interface WikiPageEntry {
	number: string;
	title: string;
	depth: number;
}

export interface WikiDetail extends WikiEntry {
	pages: WikiPageEntry[];
	/** Where the repository's files are seen on its host, for linking citations. */
	webUrl: string;
}

export interface WikiPage extends WikiPageEntry {
	purpose: string;
	sources: WikiSource[];
	body: string;
	commit: string;
}
