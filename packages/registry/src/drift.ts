/**
 * Drift: how a repository compares with a setup applied to it. The baseline is the last merged
 * pull request that applied the setup there, with the files it left the setup owning, by blob
 * id. The last scan says what the repository holds now, and the setup's pins say what it writes
 * now. Planning the setup's current files against the repository, as applying it again would,
 * finds the files that differ; the baseline says which side moved.
 */
import { MERGED_FILES, planApply, type WrittenFile } from "@gateweave/agents-adapters";
import {
	DRIFT_FILE_STATES,
	DRIFT_STATES,
	type DriftFileState,
	type DriftState,
	type SetupDrift,
} from "@gateweave/agents-model";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
	blobs,
	type RepositoryRow,
	repositories,
	repositoryFiles,
	type SetupApplicationRow,
	type SetupRow,
	setupApplications,
	setups,
} from "./db/schema";
import { textBlobId } from "./hash";
import type { Db } from "./state";

export interface DriftInput {
	/** What the setup writes now. */
	written: readonly WrittenFile[];
	/** The files the merged pull request left the setup owning. */
	applied: readonly { path: string; blob: string }[];
	/** The files the last scan read, by path. */
	files: ReadonlyMap<string, { blob: string; symlink: boolean }>;
	/** A blob's kept text, which the shared configuration files need; null when none is kept. */
	textOf: (blob: string) => string | null;
}

export interface Drift {
	state: DriftFileState | "in_sync";
	files: { path: string; state: DriftFileState }[];
}

/**
 * Compares a repository with a setup that was merged into it. A file that applying the setup
 * again would change is `behind` when the repository still holds what the merge left (or the
 * setup did not own it then), `changed` when it holds something else, and `missing` when it no
 * longer holds the file. Only the setup's part of a shared configuration file counts.
 */
export function compareDrift(input: DriftInput): Drift {
	const texts = new Map<string, string | null>();
	for (const file of input.written) {
		const entry = input.files.get(file.path);
		if (!entry || entry.symlink) continue;
		if (MERGED_FILES.has(file.path)) texts.set(file.path, input.textOf(entry.blob));
		// As when applying: equal blob ids say the file is unchanged, without its text.
		else texts.set(file.path, entry.blob === textBlobId(file.content) ? file.content : null);
	}
	const plan = planApply({
		files: input.written,
		tree: [...input.files].map(([path, { symlink }]) => ({ path, symlink })),
		texts,
	});

	const applied = new Map(input.applied.map((file) => [file.path, file.blob]));
	const files: Drift["files"] = [];
	for (const { path } of plan.changes) {
		const was = applied.get(path);
		const now = input.files.get(path);
		const state = was === undefined || now?.blob === was ? "behind" : now ? "changed" : "missing";
		files.push({ path, state });
	}
	// Applying again would leave these alone: a file the setup owned that is now a symlink, or a
	// shared configuration file that no longer parses. Unless the file is what the merge left, and
	// only its text was not kept, the repository changed it.
	for (const { path } of plan.problems) {
		const was = applied.get(path);
		if (was !== undefined && input.files.get(path)?.blob !== was) {
			files.push({ path, state: "changed" });
		}
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const state =
		DRIFT_FILE_STATES.find((candidate) => files.some((file) => file.state === candidate)) ??
		"in_sync";
	return { state, files };
}

export interface DriftEntry {
	setup: SetupRow;
	repository: RepositoryRow;
	drift: SetupDrift;
}

/**
 * Drift for each setup and live repository it was merged into: all of them, one setup's, or
 * these repositories'. `writtenOf` gives what a setup writes now; it is called once per setup.
 */
export function readDrift(
	db: Db,
	filter: { setupId?: string; repositoryIds?: ReadonlySet<string> },
	writtenOf: (setup: SetupRow) => readonly WrittenFile[],
): DriftEntry[] {
	// Durable Object SQLite binds at most 100 parameters, so a list of ids is filtered below.
	const [only] = filter.repositoryIds?.size === 1 ? filter.repositoryIds : [];
	const rows = db
		.select({ application: setupApplications, setup: setups, repository: repositories })
		.from(setupApplications)
		.innerJoin(setups, eq(setupApplications.setupId, setups.id))
		.innerJoin(repositories, eq(setupApplications.repositoryId, repositories.id))
		.where(
			and(
				isNull(repositories.removedAt),
				filter.setupId === undefined ? undefined : eq(setupApplications.setupId, filter.setupId),
				only === undefined ? undefined : eq(setupApplications.repositoryId, only),
			),
		)
		.orderBy(desc(setupApplications.createdAt))
		.all();

	// Newest first, so the first merged row of a pair is its baseline. Only one pull request per
	// pair is open at a time, and it is newer than every merged one.
	const pairs = new Map<
		string,
		{
			setup: SetupRow;
			repository: RepositoryRow;
			merged?: SetupApplicationRow;
			open?: SetupApplicationRow;
		}
	>();
	for (const { application, setup, repository } of rows) {
		if (filter.repositoryIds && !filter.repositoryIds.has(repository.id)) continue;
		const key = `${setup.id}:${repository.id}`;
		const pair = pairs.get(key) ?? { setup, repository };
		pairs.set(key, pair);
		if (application.state === "merged") pair.merged ??= application;
		else if (application.state === "open") pair.open ??= application;
	}

	const written = new Map<string, readonly WrittenFile[]>();
	const filesOf = new Map<string, Map<string, { blob: string; symlink: boolean }>>();
	const texts = new Map<string, string | null>();
	const textOf = (blob: string) => {
		if (!texts.has(blob)) {
			const row = db.select({ content: blobs.content }).from(blobs).where(eq(blobs.id, blob)).get();
			texts.set(blob, row?.content ?? null);
		}
		return texts.get(blob) ?? null;
	};

	const entries: DriftEntry[] = [];
	for (const { setup, repository, merged, open } of pairs.values()) {
		if (!merged) continue;
		const baseline = {
			pullNumber: merged.pullNumber,
			pullUrl: merged.pullUrl,
			mergedAt: merged.updatedAt,
		};
		const later = open ? { pullNumber: open.pullNumber, pullUrl: open.pullUrl } : null;
		// Until a scan reads the merge, the repository would look as if the files were missing.
		if (repository.scannedAt === null || repository.scannedAt < merged.updatedAt) {
			entries.push({
				setup,
				repository,
				drift: { state: "unscanned", merged: baseline, open: later, files: [] },
			});
			continue;
		}
		let output = written.get(setup.id);
		if (!output) {
			output = writtenOf(setup);
			written.set(setup.id, output);
		}
		let files = filesOf.get(repository.id);
		if (!files) {
			files = new Map(
				db
					.select({
						path: repositoryFiles.path,
						blob: repositoryFiles.blob,
						symlink: repositoryFiles.symlink,
					})
					.from(repositoryFiles)
					.where(eq(repositoryFiles.repositoryId, repository.id))
					.all()
					.map(({ path, ...file }) => [path, file]),
			);
			filesOf.set(repository.id, files);
		}
		const drift = compareDrift({ written: output, applied: merged.files, files, textOf });
		entries.push({ setup, repository, drift: { ...drift, merged: baseline, open: later } });
	}
	return entries;
}

/** The most urgent of these states, or null for none. */
export function mostUrgent(states: Iterable<DriftState>): DriftState | null {
	const found = new Set(states);
	return DRIFT_STATES.find((state) => found.has(state)) ?? null;
}
