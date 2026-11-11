/**
 * Repository wikis (AGT-108): each writing of one is a generation, and its pages are rows. The
 * app's `WikiWorkflow` does the writing, one step at a time, and calls the registry before and
 * after each: it plans the pages, then writes them one by one, then finishes. The registry keeps
 * what a step leaves, reads the repository for the next one, and opens the workspace's key for it.
 *
 * A generation reads one commit from planning on, so every page sees the same code. People read
 * the newest generation that is ready; finishing one deletes the older ones, so a workspace keeps
 * one wiki per repository, plus the one being written.
 */
import {
	checkCitations,
	type KeyedProvider,
	numberWikiPages,
	requestCost,
	WIKI_FILES_PER_PAGE,
	WIKI_MAX_PAGE_LENGTH,
	WIKI_MAX_PAGES,
	type WikiDetail,
	type WikiEntry,
	type WikiGeneration,
	type WikiPage,
	type WikiPageEntry,
	type WikiSource,
	type WikiStartInput,
} from "@gateweave/agents-model";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
	type FileEntry,
	type RepositoryRow,
	repositories,
	type WikiGenerationRow,
	type WikiPageRow,
	wikiGenerations,
	wikiPages,
} from "./db/schema";
import type { SourceFile } from "./scanner";
import type { Db } from "./state";

/** A generation that has not got further for this long has stopped, and counts as failed. */
export const WIKI_STALLED_MS = 60 * 60_000;

export const WIKI_STALLED = "It stopped without finishing";

/** What the workflow hears once a generation it writes has failed, or its repository has gone. */
export const WIKI_GONE = "This wiki is no longer being written";

/** How much of the repository's docs the planner reads, in characters, and of any one doc. */
export const WIKI_DOCS_BUDGET = 80_000;
export const WIKI_DOC_LENGTH = 30_000;

/** What the app's workflow is started with. */
export interface WikiParams {
	workspaceId: string;
	generation: string;
}

/** The registry's view of the app's WIKI workflow binding, which a registry in tests lacks. */
export interface WikiEnv {
	WIKI?: { create(options: { id: string; params: WikiParams }): Promise<unknown> };
}

const UNDERWAY = ["planning", "writing"] as const;

/** A file the planner sees: its path and size. Its text is read only for the pages that need it. */
export interface WikiListedFile {
	path: string;
	size: number;
}

/** What planning needs: the files, the docs worth reading first, and `.devin/wiki.json`. */
export interface WikiPlanContext {
	repository: { owner: string; name: string };
	commit: string;
	listing: WikiListedFile[];
	/** True when the listing left files out. */
	truncated: boolean;
	docs: { path: string; text: string }[];
	steering: string | null;
	model: { provider: KeyedProvider; model: string; key: string };
}

/** What writing one page needs: the page, the wiki around it, and its files' text. */
export interface WikiPageContext {
	repository: { owner: string; name: string };
	commit: string;
	page: { number: string; title: string; purpose: string; notes: string[] };
	outline: { number: string; title: string; depth: number }[];
	notes: string[];
	/** The page's files; a text is null for one that is binary or could not be read. */
	files: { path: string; text: string | null }[];
	model: { provider: KeyedProvider; model: string; key: string };
}

/** A plan as the workflow hands it over: the pages in order, each with the files it reads. */
export const wikiPlanInput = z.object({
	steered: z.boolean(),
	steeringProblem: z.string().max(1000).nullable(),
	notes: z.array(z.string().max(10_000)).max(100),
	pages: z
		.array(
			z.object({
				title: z.string().trim().min(1).max(200),
				purpose: z.string().trim().min(1).max(10_000),
				parent: z.string().trim().min(1).max(200).nullable(),
				notes: z.array(z.string().max(10_000)).max(100),
				files: z.array(z.string().min(1).max(1024)).max(50),
			}),
		)
		.min(1)
		.max(WIKI_MAX_PAGES),
});
export type WikiPlanInput = z.infer<typeof wikiPlanInput>;

/** A page as the workflow hands it over. */
export const wikiPageInput = z.object({
	body: z.string().max(WIKI_MAX_PAGE_LENGTH + 200),
	sources: z
		.array(
			z.object({ path: z.string().min(1).max(1024), lines: z.number().int().min(0).nullable() }),
		)
		.max(WIKI_FILES_PER_PAGE * 2),
});
export type WikiPageInput = z.infer<typeof wikiPageInput>;

/** The tokens a step's model requests used, and which model, for the generation's cost. */
export const wikiUsage = z.object({
	tokens: z.object({
		input: z.number().int().min(0),
		output: z.number().int().min(0),
		cacheRead: z.number().int().min(0),
		cacheWrite: z.number().int().min(0),
	}),
});
export type WikiUsage = z.infer<typeof wikiUsage>;

/**
 * Starts a generation of the repository's wiki, unless one is being written. Returns its id, or
 * why it cannot start.
 */
export function startWikiGeneration(
	db: Db,
	repositoryId: string,
	input: WikiStartInput,
	startedBy: string,
	now: number,
): { generation: string } | { refused: string } {
	const repository = liveRepository(db, repositoryId);
	if (!repository) return { refused: "This repository is not in the workspace" };
	failStalledWikis(db, now);
	const underway = db
		.select({ id: wikiGenerations.id })
		.from(wikiGenerations)
		.where(
			and(
				eq(wikiGenerations.repositoryId, repositoryId),
				inArray(wikiGenerations.status, UNDERWAY),
			),
		)
		.get();
	if (underway)
		return { refused: "This repository's wiki is being written; wait until it is done" };
	const generation = crypto.randomUUID();
	db.insert(wikiGenerations)
		.values({
			id: generation,
			repositoryId,
			status: "planning",
			provider: input.provider,
			model: input.model,
			startedBy,
			startedAt: now,
			heartbeatAt: now,
		})
		.run();
	return { generation };
}

/** Marks the generations that stopped getting further as failed, so another can start. */
export function failStalledWikis(db: Db, now: number): void {
	db.update(wikiGenerations)
		.set({ status: "failed", error: WIKI_STALLED, finishedAt: now })
		.where(
			and(
				inArray(wikiGenerations.status, UNDERWAY),
				sql`${wikiGenerations.heartbeatAt} < ${now - WIKI_STALLED_MS}`,
			),
		)
		.run();
}

/** The generation and its repository, while it is being written and the repository is live. */
export function underwayGeneration(
	db: Db,
	generationId: string,
): { generation: WikiGenerationRow; repository: RepositoryRow } | null {
	const row = db
		.select({ generation: wikiGenerations, repository: repositories })
		.from(wikiGenerations)
		.innerJoin(repositories, eq(repositories.id, wikiGenerations.repositoryId))
		.where(
			and(
				eq(wikiGenerations.id, generationId),
				inArray(wikiGenerations.status, UNDERWAY),
				isNull(repositories.removedAt),
			),
		)
		.get();
	return row ?? null;
}

/** Notes the commit and tree planning read, which every page then reads too. */
export function recordWikiCommit(
	db: Db,
	generationId: string,
	read: { commit: string; tree: string },
	now: number,
): boolean {
	const updated = db
		.update(wikiGenerations)
		.set({ ...read, heartbeatAt: now })
		.where(and(eq(wikiGenerations.id, generationId), eq(wikiGenerations.status, "planning")))
		.returning({ id: wikiGenerations.id })
		.get();
	return updated !== undefined;
}

/**
 * Saves the plan: one row per page, in reading order and numbered, each with the files its writer
 * reads, as found in the tree planning read (`files`). A file the tree does not have, or one too
 * large to read, is left out. Returns how many pages there are, or null when the generation is no
 * longer planning.
 */
export function saveWikiPlan(
	db: Db,
	generationId: string,
	plan: WikiPlanInput,
	files: ReadonlyMap<string, SourceFile>,
	usage: WikiUsage,
	now: number,
): number | null {
	const generation = db
		.select()
		.from(wikiGenerations)
		.where(and(eq(wikiGenerations.id, generationId), eq(wikiGenerations.status, "planning")))
		.get();
	if (!generation) return null;
	const seen = new Set<string>();
	const pages = plan.pages.filter((page) => {
		const key = page.title.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const numbered = numberWikiPages(pages);
	db.delete(wikiPages).where(eq(wikiPages.generationId, generationId)).run();
	numbered.forEach(({ page, number, depth }, position) => {
		const entries: FileEntry[] = [];
		for (const path of new Set(page.files)) {
			const file = files.get(path);
			if (!file || file.symlink || file.size > WIKI_MAX_FILE_BYTES) continue;
			entries.push({ path, blob: file.blob, size: file.size });
			if (entries.length === WIKI_FILES_PER_PAGE) break;
		}
		// One row at a time: Durable Object SQLite binds at most 100 parameters per query.
		db.insert(wikiPages)
			.values({
				generationId,
				position,
				number,
				depth,
				title: page.title,
				purpose: page.purpose,
				notes: page.notes,
				files: entries,
			})
			.run();
	});
	db.update(wikiGenerations)
		.set({
			status: "writing",
			steered: plan.steered,
			steeringProblem: plan.steeringProblem,
			notes: plan.notes,
			pagesTotal: numbered.length,
			pagesDone: 0,
			heartbeatAt: now,
			...spent(generation, usage, now),
		})
		.where(eq(wikiGenerations.id, generationId))
		.run();
	return numbered.length;
}

/** The largest file a page's writer reads; larger ones are listed but not read. */
export const WIKI_MAX_FILE_BYTES = 256 * 1024;

/** The page at `position` of a generation that is writing, with the outline around it. */
export function wikiPageToWrite(
	db: Db,
	generationId: string,
	position: number,
): { page: WikiPageRow; outline: WikiPageEntry[] } | null {
	const pages = db
		.select()
		.from(wikiPages)
		.where(eq(wikiPages.generationId, generationId))
		.orderBy(asc(wikiPages.position))
		.all();
	const page = pages.find((candidate) => candidate.position === position);
	if (!page) return null;
	return {
		page,
		outline: pages.map(({ number, title, depth }) => ({ number, title, depth })),
	};
}

/**
 * Saves a page's text, its citations checked against the files it read. Returns false when the
 * generation is no longer writing.
 */
export function saveWikiPage(
	db: Db,
	generationId: string,
	position: number,
	input: WikiPageInput,
	usage: WikiUsage,
	now: number,
): boolean {
	const generation = db
		.select()
		.from(wikiGenerations)
		.where(and(eq(wikiGenerations.id, generationId), eq(wikiGenerations.status, "writing")))
		.get();
	if (!generation) return false;
	const sources: WikiSource[] = input.sources;
	const body = checkCitations(input.body.slice(0, WIKI_MAX_PAGE_LENGTH), sources);
	const saved = db
		.update(wikiPages)
		.set({ body, sources, writtenAt: now })
		.where(and(eq(wikiPages.generationId, generationId), eq(wikiPages.position, position)))
		.returning({ position: wikiPages.position })
		.get();
	if (!saved) return false;
	const written = db
		.select({ n: sql<number>`count(*)` })
		.from(wikiPages)
		.where(and(eq(wikiPages.generationId, generationId), sql`${wikiPages.body} is not null`))
		.get();
	db.update(wikiGenerations)
		.set({ pagesDone: written?.n ?? 0, heartbeatAt: now, ...spent(generation, usage, now) })
		.where(eq(wikiGenerations.id, generationId))
		.run();
	return true;
}

/**
 * Makes a generation whose pages are all written the one people read, and deletes the older ones.
 * Returns false when it is not writing, or a page is missing.
 */
export function finishWikiGeneration(db: Db, generationId: string, now: number): boolean {
	const generation = db
		.select()
		.from(wikiGenerations)
		.where(and(eq(wikiGenerations.id, generationId), eq(wikiGenerations.status, "writing")))
		.get();
	if (!generation) return false;
	const missing = db
		.select({ position: wikiPages.position })
		.from(wikiPages)
		.where(and(eq(wikiPages.generationId, generationId), isNull(wikiPages.body)))
		.get();
	if (missing || generation.pagesTotal === 0) return false;
	db.update(wikiGenerations)
		.set({ status: "ready", finishedAt: now, heartbeatAt: now })
		.where(eq(wikiGenerations.id, generationId))
		.run();
	const older = db
		.select({ id: wikiGenerations.id })
		.from(wikiGenerations)
		.where(
			and(
				eq(wikiGenerations.repositoryId, generation.repositoryId),
				ne(wikiGenerations.id, generationId),
				inArray(wikiGenerations.status, ["ready", "failed"]),
			),
		)
		.all();
	for (const { id } of older) {
		db.delete(wikiPages).where(eq(wikiPages.generationId, id)).run();
		db.delete(wikiGenerations).where(eq(wikiGenerations.id, id)).run();
	}
	return true;
}

/**
 * Marks a generation being written as failed, with why, and deletes its pages: the wiki people
 * read stays as it was. Returns false when it was not being written.
 */
export function failWikiGeneration(
	db: Db,
	generationId: string,
	message: string,
	now: number,
): boolean {
	const failed = db
		.update(wikiGenerations)
		.set({ status: "failed", error: message.slice(0, 1000), finishedAt: now })
		.where(and(eq(wikiGenerations.id, generationId), inArray(wikiGenerations.status, UNDERWAY)))
		.returning({ repositoryId: wikiGenerations.repositoryId })
		.get();
	if (!failed) return false;
	db.delete(wikiPages).where(eq(wikiPages.generationId, generationId)).run();
	// Only the newest failure is worth showing.
	const others = db
		.select({ id: wikiGenerations.id })
		.from(wikiGenerations)
		.where(
			and(
				eq(wikiGenerations.repositoryId, failed.repositoryId),
				ne(wikiGenerations.id, generationId),
				eq(wikiGenerations.status, "failed"),
			),
		)
		.all();
	for (const { id } of others) db.delete(wikiGenerations).where(eq(wikiGenerations.id, id)).run();
	return true;
}

/** Adds a step's tokens and their cost to the generation's. */
function spent(generation: WikiGenerationRow, usage: WikiUsage, now: number) {
	const { tokens } = usage;
	const cost = requestCost(generation.provider, generation.model, tokens, now);
	return {
		inputTokens: generation.inputTokens + tokens.input,
		outputTokens: generation.outputTokens + tokens.output,
		cacheReadTokens: generation.cacheReadTokens + tokens.cacheRead,
		cacheWriteTokens: generation.cacheWriteTokens + tokens.cacheWrite,
		cost: generation.cost === null || cost === null ? null : generation.cost + cost,
	};
}

/** Every live repository with its wiki, by name. */
export function listWikiEntries(db: Db, now: number): WikiEntry[] {
	const repos = db
		.select()
		.from(repositories)
		.where(isNull(repositories.removedAt))
		.orderBy(asc(repositories.owner), asc(repositories.name))
		.all();
	const generations = db
		.select()
		.from(wikiGenerations)
		.orderBy(desc(wikiGenerations.startedAt))
		.all();
	return repos.map((repository) =>
		entryOf(
			repository,
			generations.filter((generation) => generation.repositoryId === repository.id),
			now,
		),
	);
}

/** A live repository's wiki with its table of contents. */
export function wikiDetail(db: Db, repositoryId: string, now: number): WikiDetail | null {
	const repository = liveRepository(db, repositoryId);
	if (!repository) return null;
	const generations = db
		.select()
		.from(wikiGenerations)
		.where(eq(wikiGenerations.repositoryId, repositoryId))
		.orderBy(desc(wikiGenerations.startedAt))
		.all();
	const entry = entryOf(repository, generations, now);
	const pages = entry.live
		? db
				.select({ number: wikiPages.number, title: wikiPages.title, depth: wikiPages.depth })
				.from(wikiPages)
				.where(eq(wikiPages.generationId, entry.live.id))
				.orderBy(asc(wikiPages.position))
				.all()
		: [];
	return { ...entry, pages, webUrl: webUrlOf(repository) };
}

/** One page of a live repository's wiki, by its number, such as `2.1`. */
export function wikiPage(db: Db, repositoryId: string, number: string): WikiPage | null {
	const live = liveGeneration(db, repositoryId);
	if (!live?.commit) return null;
	const page = db
		.select()
		.from(wikiPages)
		.where(and(eq(wikiPages.generationId, live.id), eq(wikiPages.number, number)))
		.get();
	if (!page || page.body === null) return null;
	return pageOf(page, live.commit);
}

/** Every page of a live repository's wiki in reading order, for reading it whole. */
export function wikiPagesOf(db: Db, repositoryId: string): WikiPage[] | null {
	const live = liveGeneration(db, repositoryId);
	if (!live?.commit) return null;
	const commit = live.commit;
	return db
		.select()
		.from(wikiPages)
		.where(eq(wikiPages.generationId, live.id))
		.orderBy(asc(wikiPages.position))
		.all()
		.filter((page) => page.body !== null)
		.map((page) => pageOf(page, commit));
}

/**
 * The live repository named `owner/name`, ignoring case, as DeepWiki's tools name one. With two
 * (a GitHub and a GitLab one), the one with a wiki.
 */
export function repositoryNamed(db: Db, fullName: string): string | null {
	const slash = fullName.indexOf("/");
	if (slash <= 0) return null;
	const owner = fullName.slice(0, slash).toLowerCase();
	const name = fullName.slice(slash + 1).toLowerCase();
	const found = db
		.select({ id: repositories.id })
		.from(repositories)
		.where(
			and(
				isNull(repositories.removedAt),
				sql`lower(${repositories.owner}) = ${owner}`,
				sql`lower(${repositories.name}) = ${name}`,
			),
		)
		.all();
	return (
		found.find((repository) => liveGeneration(db, repository.id) !== undefined)?.id ??
		found[0]?.id ??
		null
	);
}

function liveRepository(db: Db, repositoryId: string): RepositoryRow | undefined {
	return db
		.select()
		.from(repositories)
		.where(and(eq(repositories.id, repositoryId), isNull(repositories.removedAt)))
		.get();
}

function liveGeneration(db: Db, repositoryId: string): WikiGenerationRow | undefined {
	return db
		.select()
		.from(wikiGenerations)
		.where(and(eq(wikiGenerations.repositoryId, repositoryId), eq(wikiGenerations.status, "ready")))
		.orderBy(desc(wikiGenerations.finishedAt))
		.get();
}

/** The live wiki and, when newer, the one being written or the last that failed. */
function entryOf(
	repository: RepositoryRow,
	newestFirst: readonly WikiGenerationRow[],
	now: number,
): WikiEntry {
	const live = newestFirst.find((generation) => generation.status === "ready");
	const latest = newestFirst.find(
		(generation) =>
			generation.status !== "ready" && (!live || generation.startedAt > live.startedAt),
	);
	return {
		repositoryId: repository.id,
		provider: repository.provider,
		owner: repository.owner,
		name: repository.name,
		private: repository.private,
		live: live ? generationOf(live, now) : null,
		latest: latest ? generationOf(latest, now) : null,
	};
}

function generationOf(row: WikiGenerationRow, now: number): WikiGeneration {
	const stalled =
		(row.status === "planning" || row.status === "writing") &&
		row.heartbeatAt < now - WIKI_STALLED_MS;
	return {
		id: row.id,
		status: stalled ? "failed" : row.status,
		commit: row.commit,
		steered: row.steered,
		steeringProblem: row.steeringProblem,
		provider: row.provider,
		model: row.model,
		startedBy: row.startedBy,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		error: stalled ? WIKI_STALLED : row.error,
		pagesTotal: row.pagesTotal,
		pagesDone: row.pagesDone,
		tokens: {
			input: row.inputTokens,
			output: row.outputTokens,
		},
		cost: row.cost,
	};
}

function pageOf(row: WikiPageRow, commit: string): WikiPage {
	return {
		number: row.number,
		title: row.title,
		depth: row.depth,
		purpose: row.purpose,
		sources: row.sources ?? [],
		body: row.body ?? "",
		commit,
	};
}

/** The repository's page on its host, under which its files are. */
export function webUrlOf(repository: RepositoryRow): string {
	return repository.provider === "gitlab" && repository.webUrl
		? repository.webUrl
		: `https://github.com/${repository.owner}/${repository.name}`;
}

// What the planner is shown of the repository.

/** Directories that hold what others wrote or what a build made, never worth a page. */
const SKIPPED_DIRECTORIES = new Set([
	".git",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	".turbo",
	".venv",
	"__pycache__",
	"bower_components",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"vendor",
	"venv",
]);

const SKIPPED_FILES = new Set([
	"bun.lockb",
	"Cargo.lock",
	"composer.lock",
	"Gemfile.lock",
	"go.sum",
	"package-lock.json",
	"pnpm-lock.yaml",
	"poetry.lock",
	"uv.lock",
	"yarn.lock",
]);

/** Extensions of files with no text worth reading. */
const BINARY =
	/\.(avif|bin|bmp|class|dll|dylib|eot|exe|gif|gz|ico|jar|jpe?g|mp3|mp4|otf|pdf|png|so|tar|tgz|ttf|wasm|webm|webp|woff2?|zip)$/i;

/** The most files the planner is shown; in a larger repository, the shallowest. */
export const WIKI_MAX_LISTED = 4000;

/** Whether a file is worth listing for the planner. */
export function wikiWorthListing(file: SourceFile): boolean {
	if (file.symlink || file.size > WIKI_MAX_FILE_BYTES) return false;
	const parts = file.path.split("/");
	const name = parts.at(-1) ?? "";
	if (parts.slice(0, -1).some((part) => SKIPPED_DIRECTORIES.has(part))) return false;
	if (SKIPPED_FILES.has(name) || BINARY.test(name)) return false;
	return !/\.min\.(js|css)$|\.map$/.test(name);
}

/** The files the planner sees, shallowest first when there are too many, then by path. */
export function wikiListing(files: readonly SourceFile[]): {
	listing: WikiListedFile[];
	truncated: boolean;
} {
	const worth = files.filter(wikiWorthListing);
	const depth = (path: string) => path.split("/").length;
	const kept =
		worth.length <= WIKI_MAX_LISTED
			? worth
			: [...worth]
					.sort((a, b) => depth(a.path) - depth(b.path) || compare(a.path, b.path))
					.slice(0, WIKI_MAX_LISTED);
	return {
		listing: [...kept]
			.sort((a, b) => compare(a.path, b.path))
			.map(({ path, size }) => ({ path, size })),
		truncated: kept.length < worth.length,
	};
}

/** Docs the planner reads before it plans, in this order, up to a budget. */
export function wikiDocs(files: readonly SourceFile[]): SourceFile[] {
	const rank = (path: string): number | null => {
		const lower = path.toLowerCase();
		if (/^readme(\.\w+)?$/.test(lower)) return 0;
		if (lower === "agents.md" || lower === "claude.md") return 1;
		if (/^docs\/[^/]+\.(md|mdx)$/.test(lower)) return 2;
		if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pnpm-workspace\.yaml)$/.test(lower)) {
			return 3;
		}
		if (/^docs\/.+\.(md|mdx)$/.test(lower)) return 4;
		if (/^[^/]+\/[^/]+\/readme\.md$|^[^/]+\/readme\.md$/.test(lower)) return 5;
		return null;
	};
	return files
		.filter((file) => wikiWorthListing(file) && rank(file.path) !== null)
		.sort((a, b) => (rank(a.path) ?? 9) - (rank(b.path) ?? 9) || compare(a.path, b.path))
		.slice(0, 40);
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
