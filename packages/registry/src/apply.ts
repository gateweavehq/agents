/**
 * Applying a setup to a repository. The setup's files, merged with what the default branch holds
 * at its head, go into one commit on a branch of their own, proposed by a pull request. The
 * default branch is never written, and no file the setup does not write is touched: the commit's
 * tree is the head's, with only the setup's files replaced.
 *
 * Talking to GitHub takes many awaits, so nothing here writes the registry in the middle of it.
 * `prepareApplication` reads the registry, `runApplication` talks to GitHub and hands each
 * outcome to `save` as soon as GitHub has it, and the caller writes that in a transaction.
 */
import { MERGED_FILES, planApply, type WrittenFile } from "@gateweave/agents-adapters";
import { type CommitInput, GitHubError, type PullRequest } from "@gateweave/agents-github";
import {
	type ApplicationState,
	type ApplyProblem,
	ASSET_KIND_NAMES,
	type AssetKind,
	RUNTIME_NAMES,
} from "@gateweave/agents-model";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
	blobs,
	type RepositoryRow,
	repositories,
	type SetupApplicationRow,
	type SetupRow,
	setupApplications,
	setups,
} from "./db/schema";
import { gitBlobId } from "./hash";
import { writeSetup } from "./queries";
import type { RepositorySource, SourceFile } from "./scanner";
import type { Db } from "./state";

type Pin = { assetId: string; version: number };
type OwnedFile = { path: string; blob: string };

/** A refusal to apply, with a message fit to show the person who asked. */
export class ApplyError extends Error {}

/** Where a setup is written. GitHub is the only one so far. */
export interface RepositoryWriter extends RepositorySource {
	/** A commit of these files on top of the parent; no branch moves. */
	commit(input: CommitInput): Promise<string>;
	/** The commit a branch is at, or null when there is no such branch. */
	branchCommit(branch: string): Promise<string | null>;
	createBranch(branch: string, commit: string): Promise<void>;
	/** Moves the branch even when that is not a fast-forward, so check where it is first. */
	moveBranch(branch: string, commit: string): Promise<void>;
	/** Opens it against the default branch. */
	openPullRequest(input: { title: string; body: string; head: string }): Promise<PullRequest>;
	pullRequest(number: number): Promise<PullRequest | null>;
	updatePullRequest(number: number, input: { title: string; body: string }): Promise<PullRequest>;
}

export interface Prepared {
	setup: SetupRow;
	repository: RepositoryRow;
	pins: { assetId: string; version: number }[];
	/** For the pull request's description. */
	assets: { name: string; kind: AssetKind; version: number }[];
	files: WrittenFile[];
	/** Assets the writers left out, and why. */
	unwritten: { asset: string; message: string }[];
	/** The application whose pull request was open when last seen, if any. */
	open: SetupApplicationRow | null;
}

export type Ran =
	| {
			status: "opened" | "updated" | "current";
			application: SetupApplicationRow;
			problems: ApplyProblem[];
	  }
	| { status: "unchanged"; application: null; problems: ApplyProblem[] };

/** What GitHub said in the meantime, to write as soon as it is known. */
export type Saved =
	| { kind: "application"; row: SetupApplicationRow }
	| { kind: "state"; id: string; state: ApplicationState };

export function prepareApplication(db: Db, setupId: string, repositoryId: string): Prepared {
	const setup = db.select().from(setups).where(eq(setups.id, setupId)).get();
	if (!setup) throw new ApplyError("That setup does not exist");
	const repository = db
		.select()
		.from(repositories)
		.where(and(eq(repositories.id, repositoryId), isNull(repositories.removedAt)))
		.get();
	if (!repository) throw new ApplyError("That repository does not exist");
	const { pinned, written } = writeSetup(db, setup);
	if (written.files.length === 0) throw new ApplyError("This setup writes no files yet");
	const open = db
		.select()
		.from(setupApplications)
		.where(
			and(
				eq(setupApplications.setupId, setupId),
				eq(setupApplications.repositoryId, repositoryId),
				eq(setupApplications.state, "open"),
			),
		)
		.orderBy(desc(setupApplications.createdAt))
		.get();
	return {
		setup,
		repository,
		pins: pinned.map(({ asset, version }) => ({ assetId: asset.id, version })),
		assets: pinned.map(({ asset, version }) => ({ name: asset.name, kind: asset.kind, version })),
		files: written.files,
		unwritten: written.problems,
		open: open ?? null,
	};
}

export async function runApplication(
	db: Db,
	writer: RepositoryWriter,
	prepared: Prepared,
	setupUrl: string | null,
	save: (saved: Saved) => void,
): Promise<Ran> {
	const { owner, name, defaultBranch } = prepared.repository;
	try {
		return await run(db, writer, prepared, setupUrl, save);
	} catch (error) {
		if (!(error instanceof GitHubError)) throw error;
		console.error(`registry: applying a setup to ${owner}/${name} failed`, error.message);
		if (error.status === 403) {
			throw new ApplyError(
				`The GitHub App may not write to ${owner}/${name}. Whoever manages its installation on GitHub has to accept its permissions for contents and pull requests, then apply again.`,
			);
		}
		if (error.status === 404) {
			throw new ApplyError(`GitHub could not find ${owner}/${name} or its ${defaultBranch} branch`);
		}
		if (error.status === 409) throw new ApplyError(`${owner}/${name} has no commits yet`);
		if (error.status === 0) throw new ApplyError("GitHub could not be reached; try again");
		throw new ApplyError(`GitHub refused the change: ${error.message}`);
	}
}

async function run(
	db: Db,
	writer: RepositoryWriter,
	prepared: Prepared,
	setupUrl: string | null,
	save: (saved: Saved) => void,
): Promise<Ran> {
	const { setup, repository } = prepared;
	let open = prepared.open;
	if (open) {
		const pull = await writer.pullRequest(open.pullNumber);
		if (pull?.state !== "open") {
			// Closed or merged while no webhook told the registry, so this is a new application.
			save({ kind: "state", id: open.id, state: pull?.state ?? "closed" });
			open = null;
		} else if ((await writer.branchCommit(open.branch)) !== open.commit) {
			throw new ApplyError(
				`Someone else pushed to ${open.branch}, so pull request #${open.pullNumber} was left as it is. Merge or close it, then apply again.`,
			);
		}
	}

	const head = await writer.head();
	const listing = await writer.files(head.tree);
	if (listing.truncated) {
		throw new ApplyError(
			`${repository.owner}/${repository.name} has too many files for GitHub to list them all, so it is not safe to write into`,
		);
	}
	const entries = new Map(listing.files.map((file) => [file.path, file]));
	const plan = planApply({
		files: prepared.files,
		tree: listing.files.map(({ path, symlink }) => ({ path, symlink })),
		texts: await textsFor(db, writer, prepared.files, entries),
	});
	if (plan.changes.length === 0) {
		return { status: "unchanged", application: null, problems: plan.problems };
	}

	const owned = [
		...plan.changes.map((file) => ({ path: file.path, blob: blobOf(file.content) })),
		...plan.unchanged.map((path) => ({ path, blob: entries.get(path)?.blob ?? "" })),
	].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (open && sameFiles(open.files, owned)) {
		// The open pull request already writes exactly this; another commit would change nothing.
		if (samePins(open.pins, prepared.pins)) {
			return { status: "current", application: open, problems: plan.problems };
		}
		const row = { ...open, pins: prepared.pins, updatedAt: Date.now() };
		save({ kind: "application", row });
		return { status: "current", application: row, problems: plan.problems };
	}
	const title = `chore(agents): apply the ${oneLine(setup.name)} setup`;
	const body = describe(prepared, plan, setupUrl);
	const commit = await writer.commit({
		parent: head.commit,
		tree: head.tree,
		files: plan.changes,
		message: `${title}\n\nWritten by Gateweave Agents from the setup's pinned library versions.`,
	});
	const now = Date.now();

	if (open) {
		// The branch is still where this registry left it, so moving it drops nobody's work.
		await writer.moveBranch(open.branch, commit);
		const row = { ...open, pins: prepared.pins, files: owned, commit, updatedAt: now };
		save({ kind: "application", row });
		try {
			await writer.updatePullRequest(open.pullNumber, { title, body });
		} catch (error) {
			// The commit is what matters; a stale description is not worth failing over.
			console.error("registry: updating a pull request's description failed", String(error));
		}
		return { status: "updated", application: row, problems: plan.problems };
	}

	const id = crypto.randomUUID();
	const branch = branchName(setup.name, id);
	await writer.createBranch(branch, commit);
	const pull = await writer.openPullRequest({ title, body, head: branch });
	const row: SetupApplicationRow = {
		id,
		setupId: setup.id,
		repositoryId: repository.id,
		pins: prepared.pins,
		files: owned,
		branch,
		commit,
		pullNumber: pull.number,
		pullUrl: pull.url,
		state: "open",
		createdAt: now,
		updatedAt: now,
	};
	save({ kind: "application", row });
	return { status: "opened", application: row, problems: plan.problems };
}

export function saveApplication(db: Db, saved: Saved, now: number): void {
	if (saved.kind === "state") {
		db.update(setupApplications)
			.set({ state: saved.state, updatedAt: now })
			.where(eq(setupApplications.id, saved.id))
			.run();
		return;
	}
	const { row } = saved;
	db.insert(setupApplications)
		.values(row)
		.onConflictDoUpdate({
			target: setupApplications.id,
			set: { pins: row.pins, files: row.files, commit: row.commit, updatedAt: row.updatedAt },
		})
		.run();
}

/**
 * Follows a pull request's state, as GitHub's webhooks report it. False when the pull request
 * does not apply a setup.
 */
export function recordPullRequest(
	db: Db,
	repositoryId: string,
	pullNumber: number,
	state: ApplicationState,
	now: number,
): boolean {
	const changed = db
		.update(setupApplications)
		.set({ state, updatedAt: now })
		.where(
			and(
				eq(setupApplications.repositoryId, repositoryId),
				eq(setupApplications.pullNumber, pullNumber),
			),
		)
		.returning({ id: setupApplications.id })
		.all();
	return changed.length > 0;
}

/**
 * What the plan needs to know of the repository's copy of each file the setup writes. A merged
 * file needs its text. For any other file, equal blob ids are enough to know it is unchanged, so
 * its text is not fetched: the setup's own text stands for an equal file, null for a different one.
 */
async function textsFor(
	db: Db,
	writer: RepositoryWriter,
	files: readonly WrittenFile[],
	entries: ReadonlyMap<string, SourceFile>,
): Promise<Map<string, string | null>> {
	const texts = new Map<string, string | null>();
	const missing = new Map<string, string[]>();
	for (const file of files) {
		const entry = entries.get(file.path);
		if (!entry || entry.symlink) continue;
		if (!MERGED_FILES.has(file.path)) {
			texts.set(file.path, entry.blob === blobOf(file.content) ? file.content : null);
			continue;
		}
		// The last scan most likely brought this file's text already.
		const kept = db
			.select({ content: blobs.content })
			.from(blobs)
			.where(eq(blobs.id, entry.blob))
			.get();
		if (kept) texts.set(file.path, kept.content);
		else missing.set(entry.blob, [...(missing.get(entry.blob) ?? []), file.path]);
	}
	if (missing.size > 0) {
		const fetched = await writer.texts([...missing.keys()]);
		for (const [blob, paths] of missing) {
			for (const path of paths) texts.set(path, fetched.get(blob) ?? null);
		}
	}
	return texts;
}

function sameFiles(a: readonly OwnedFile[], b: readonly OwnedFile[]): boolean {
	return (
		a.length === b.length &&
		a.every((file, index) => {
			const other = b[index];
			return other?.path === file.path && other.blob === file.blob;
		})
	);
}

function samePins(a: readonly Pin[], b: readonly Pin[]): boolean {
	const versions = new Map(a.map((pin) => [pin.assetId, pin.version]));
	return a.length === b.length && b.every((pin) => versions.get(pin.assetId) === pin.version);
}

const encoder = new TextEncoder();

function blobOf(text: string): string {
	return gitBlobId(encoder.encode(text));
}

/** `gateweave/<the setup's name as a slug>-<the application's id>`, unique to the application. */
function branchName(setupName: string, id: string): string {
	const slug = setupName
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return `gateweave/${slug || "setup"}-${id.slice(0, 8)}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Text for a Markdown table cell. */
function cell(text: string): string {
	return oneLine(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** A path as inline code, with a fence longer than any run of backticks inside it. */
function code(path: string): string {
	const longest = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return longest > 0 ? `${fence} ${path} ${fence}` : `${fence}${path}${fence}`;
}

function describe(
	prepared: Prepared,
	plan: { changes: WrittenFile[]; problems: ApplyProblem[] },
	setupUrl: string | null,
): string {
	const runtimes = new Intl.ListFormat("en", { type: "conjunction" }).format(
		prepared.setup.runtimes.map((runtime) => RUNTIME_NAMES[runtime]),
	);
	const lines = [
		`Writes the **${cell(prepared.setup.name)}** setup from Gateweave Agents into this repository, for ${runtimes}.`,
		"",
		"| Asset | Kind | Version |",
		"| --- | --- | --- |",
		...prepared.assets.map(
			(asset) => `| ${cell(asset.name)} | ${ASSET_KIND_NAMES[asset.kind]} | v${asset.version} |`,
		),
		"",
		"**Files**",
		"",
		...plan.changes.map((file) =>
			MERGED_FILES.has(file.path)
				? `- ${code(file.path)}: the setup's servers, merged into what the file already held`
				: `- ${code(file.path)}`,
		),
	];
	if (plan.problems.length > 0) {
		lines.push("", "**Left alone**", "");
		for (const problem of plan.problems)
			lines.push(`- ${code(problem.path)}: ${oneLine(problem.message)}`);
	}
	if (prepared.unwritten.length > 0) {
		lines.push("", "**Not written**", "");
		for (const problem of prepared.unwritten) {
			lines.push(`- ${cell(problem.asset)}: ${oneLine(problem.message)}`);
		}
	}
	const setup = setupUrl ? `[the setup](${setupUrl.replace(/\)/g, "%29")})` : "the setup";
	lines.push(
		"",
		`Pins move only in ${setup}. Applying it again while this pull request is open updates it.`,
	);
	return lines.join("\n");
}
