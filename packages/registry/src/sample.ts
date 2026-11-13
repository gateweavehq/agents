/**
 * Sample history for the app's public demo, where each visitor's sandbox opens with a workspace
 * that looks used: past conversations and their runs, a setup merged into a repository by a pull
 * request, and a wiki. Nothing else writes those without a model, a pull request or a run having
 * happened, so this writes them as those would have, with the times they would have had.
 *
 * `RegistryDO.importSample` is its only way in, and refuses unless the deployment is the demo.
 */
import type { RunStatus, WikiStartInput } from "@gateweave/agents-model";
import { conversations, runs, setupApplications } from "./db/schema";
import type { RunParent } from "./runs";
import type { SourceFile } from "./scanner";
import type { Db } from "./state";
import {
	finishWikiGeneration,
	recordWikiCommit,
	saveWikiPage,
	saveWikiPlan,
	startWikiGeneration,
	type WikiPageInput,
	type WikiPlanInput,
	type WikiUsage,
	wikiPageToWrite,
} from "./wiki";

/** A conversation that happened: with an agent, a team's lead, or a nested turn of one. */
export interface SampleConversation {
	id: string;
	agentId: string;
	teamId: string | null;
	/** For a nested turn's conversation, the one its person started. */
	rootId: string | null;
	title: string;
	startedAt: number;
	updatedAt: number;
}

/** A run that ended, with the totals its trace adds up to. */
export interface SampleRun {
	id: string;
	agentId: string;
	conversationId: string;
	provider: "anthropic" | "openai" | "google";
	model: string;
	status: Exclude<RunStatus, "running">;
	error: string | null;
	steps: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cost: number | null;
	startedAt: number;
	endedAt: number;
	teamPath: string[] | null;
	parent: RunParent | null;
}

/** A setup's pull request that was merged, with the files it left the setup owning. */
export interface SampleApplication {
	setupId: string;
	repositoryId: string;
	pins: { assetId: string; version: number }[];
	files: { path: string; blob: string }[];
	branch: string;
	commit: string;
	pullNumber: number;
	pullUrl: string;
	openedAt: number;
	mergedAt: number;
}

/** A wiki written at one commit: its plan, its pages by title, and what the model used. */
export interface SampleWiki {
	repositoryId: string;
	model: WikiStartInput;
	commit: string;
	tree: string;
	plan: WikiPlanInput;
	/** The files the pages read, as the tree at `commit` has them. */
	files: SourceFile[];
	pages: Record<string, WikiPageInput>;
	usage: WikiUsage;
	startedAt: number;
	finishedAt: number;
}

export interface SampleInput {
	/** The member whose conversations and runs these are, and who wrote the wiki. */
	startedBy: string;
	conversations: SampleConversation[];
	runs: SampleRun[];
	applications: SampleApplication[];
	wikis: SampleWiki[];
}

/** Writes the sample history, in one transaction with the caller's. */
export function importSample(db: Db, sample: SampleInput): void {
	const { startedBy } = sample;
	// One row a statement: Durable Object SQLite binds at most 100 parameters per query.
	for (const conversation of sample.conversations) {
		db.insert(conversations)
			.values({
				id: conversation.id,
				agentId: conversation.agentId,
				startedBy,
				title: conversation.title,
				teamId: conversation.teamId,
				rootId: conversation.rootId,
				createdAt: conversation.startedAt,
				updatedAt: conversation.updatedAt,
			})
			.run();
	}
	for (const { parent, ...run } of sample.runs) {
		db.insert(runs)
			.values({ ...run, startedBy, ...parent })
			.run();
	}
	for (const application of sample.applications) {
		const { openedAt, mergedAt, ...row } = application;
		db.insert(setupApplications)
			.values({
				...row,
				id: crypto.randomUUID(),
				state: "merged",
				createdAt: openedAt,
				updatedAt: mergedAt,
			})
			.run();
	}
	for (const wiki of sample.wikis) writeWiki(db, startedBy, wiki);
}

/** A wiki, through the steps its workflow takes, each at the time it would have. */
function writeWiki(db: Db, startedBy: string, wiki: SampleWiki): void {
	const started = startWikiGeneration(db, wiki.repositoryId, wiki.model, startedBy, wiki.startedAt);
	if ("refused" in started) throw new Error(started.refused);
	const { generation } = started;
	recordWikiCommit(db, generation, { commit: wiki.commit, tree: wiki.tree }, wiki.startedAt);
	const files = new Map(wiki.files.map((file) => [file.path, file]));
	const total = saveWikiPlan(db, generation, wiki.plan, files, wiki.usage, wiki.startedAt);
	if (total === null) throw new Error("The sample wiki's plan was not saved");
	const none: WikiUsage = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	for (let position = 0; position < total; position++) {
		// The plan numbers its pages in reading order, which may not be the order they were given.
		const title = wikiPageToWrite(db, generation, position)?.page.title;
		const page = title === undefined ? undefined : wiki.pages[title];
		if (!page) throw new Error(`The sample wiki has no page called ${title}`);
		saveWikiPage(db, generation, position, page, none, wiki.finishedAt);
	}
	if (!finishWikiGeneration(db, generation, wiki.finishedAt)) {
		throw new Error("The sample wiki was not finished");
	}
}
