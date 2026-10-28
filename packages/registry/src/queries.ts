// Durable Object SQLite binds at most 100 parameters per query, so lists of ids are joined or
// looked up one by one rather than passed to IN (...).

import { type AssetToWrite, writeAssets } from "@gateweave/agents-adapters";
import type {
	Agent,
	AgentDefinition,
	AgentDetail,
	Asset,
	AssetDetail,
	AssetFile,
	AssetVersion,
	LibraryEntry,
	LibraryUse,
	Overview,
	PinnedAsset,
	Project,
	ProjectDetail,
	Repository,
	RepositoryDetail,
	RunnableAgent,
	SetupDetail,
	SetupEntry,
} from "@gateweave/agents-model";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
	agentAssets,
	agentDefinitions,
	agents,
	assets,
	assetVersions,
	blobs,
	projectRepositories,
	projects,
	repositories,
	type SetupRow,
	scanRequests,
	setupApplications,
	setupAssets,
	setups,
} from "./db/schema";
import { type DriftEntry, mostUrgent, readDrift } from "./drift";
import {
	type Db,
	groupBy,
	toAgent,
	toApplication,
	toAsset,
	toProject,
	toRepository,
	toSetup,
} from "./state";

const liveRepository = isNull(repositories.removedAt);

/** Live rows of a table with a `repository_id`: not removed, and not in a removed repository. */
const liveIn = (table: typeof agents | typeof assets) =>
	and(isNull(table.removedAt), or(isNull(table.repositoryId), liveRepository));

export function readOverview(db: Db): Overview {
	const total = (row: { n: number } | undefined) => row?.n ?? 0;
	return {
		projects: total(db.select({ n: count() }).from(projects).get()),
		repositories: total(db.select({ n: count() }).from(repositories).where(liveRepository).get()),
		agents: total(
			db
				.select({ n: count() })
				.from(agents)
				.leftJoin(repositories, eq(agents.repositoryId, repositories.id))
				.where(liveIn(agents))
				.get(),
		),
		assets: total(
			db
				.select({ n: count() })
				.from(assets)
				.leftJoin(repositories, eq(assets.repositoryId, repositories.id))
				.where(liveIn(assets))
				.get(),
		),
	};
}

/** Projects with their live repositories, by name: all of them, or the one with this id. */
function readProjects(db: Db, id?: string): Project[] {
	const links = groupBy(
		db
			.select({
				projectId: projectRepositories.projectId,
				repositoryId: projectRepositories.repositoryId,
			})
			.from(projectRepositories)
			.innerJoin(repositories, eq(projectRepositories.repositoryId, repositories.id))
			.where(and(liveRepository, id ? eq(projectRepositories.projectId, id) : undefined))
			.orderBy(asc(repositories.owner), asc(repositories.name))
			.all()
			.map((link) => [link.projectId, link.repositoryId] as const),
	);
	return db
		.select()
		.from(projects)
		.where(id ? eq(projects.id, id) : undefined)
		.orderBy(asc(projects.name))
		.all()
		.map((row) => toProject(row, links.get(row.id) ?? []));
}

export const listProjects = (db: Db): Project[] => readProjects(db);

export const findProject = (db: Db, id: string): Project | null => readProjects(db, id)[0] ?? null;

/** A project with its live repositories and the agents in them. */
export function getProject(db: Db, id: string): ProjectDetail | null {
	const project = findProject(db, id);
	if (!project) return null;
	// Subqueries, not lists of ids: they bind one parameter however many repositories it has.
	const inProject = db
		.select({ id: projectRepositories.repositoryId })
		.from(projectRepositories)
		.where(eq(projectRepositories.projectId, id));
	return {
		project,
		repositories: repositoriesWhere(db, inArray(repositories.id, inProject)),
		agents: agentsWhere(db, and(liveIn(agents), inArray(agents.repositoryId, inProject))),
	};
}

/** Live repositories, by owner and name, with their projects and the runtimes found in them. */
/** `drift` is what `readDriftOf` returned for these repositories, when the caller has it. */
function repositoriesWhere(db: Db, where?: SQL, drift?: readonly DriftEntry[]): Repository[] {
	const live = where ? and(liveRepository, where) : liveRepository;
	const links = groupBy(
		db
			.select({
				repositoryId: projectRepositories.repositoryId,
				projectId: projectRepositories.projectId,
			})
			.from(projectRepositories)
			.innerJoin(projects, eq(projectRepositories.projectId, projects.id))
			.innerJoin(repositories, eq(projectRepositories.repositoryId, repositories.id))
			.where(live)
			.orderBy(asc(projects.name))
			.all()
			.map((link) => [link.repositoryId, link.projectId] as const),
	);
	const runtimes = groupBy(
		db
			.selectDistinct({ repositoryId: repositories.id, runtime: agents.runtime })
			.from(agents)
			.innerJoin(repositories, eq(agents.repositoryId, repositories.id))
			.where(and(isNull(agents.removedAt), live))
			.all()
			.map((row) => [row.repositoryId, row.runtime] as const),
	);
	const pending = new Set(
		db
			.select({ id: scanRequests.repositoryId })
			.from(scanRequests)
			.innerJoin(repositories, eq(scanRequests.repositoryId, repositories.id))
			.where(live)
			.all()
			.map((row) => row.id),
	);
	const rows = db
		.select()
		.from(repositories)
		.where(live)
		.orderBy(asc(repositories.owner), asc(repositories.name))
		.all();
	const states = groupBy(
		(drift ?? readDriftOf(db, { repositoryIds: new Set(rows.map((row) => row.id)) })).map(
			(entry) => [entry.repository.id, entry.drift.state] as const,
		),
	);
	return rows.map((row) =>
		toRepository(
			row,
			links.get(row.id) ?? [],
			runtimes.get(row.id) ?? [],
			pending.has(row.id),
			mostUrgent(states.get(row.id) ?? []),
		),
	);
}

/** Drift, with each setup's files as its pins write them now. */
const readDriftOf = (db: Db, filter: { setupId?: string; repositoryIds?: ReadonlySet<string> }) =>
	readDrift(db, filter, (setup) => writeSetup(db, setup).written.files);

export const listRepositories = (db: Db): Repository[] => repositoriesWhere(db);

export function getRepository(db: Db, id: string): RepositoryDetail | null {
	const drift = readDriftOf(db, { repositoryIds: new Set([id]) });
	const [repository] = repositoriesWhere(db, eq(repositories.id, id), drift);
	if (!repository) return null;
	return {
		repository,
		agents: agentsWhere(db, and(eq(agents.repositoryId, id), isNull(agents.removedAt))),
		assets: db
			.select()
			.from(assets)
			.where(and(eq(assets.repositoryId, id), isNull(assets.removedAt)))
			.orderBy(asc(assets.kind), asc(assets.key))
			.all()
			.map(toAsset),
		applications: db
			.select({
				application: setupApplications,
				setup: { id: setups.id, name: setups.name },
			})
			.from(setupApplications)
			.innerJoin(setups, eq(setupApplications.setupId, setups.id))
			.where(eq(setupApplications.repositoryId, id))
			.orderBy(desc(setupApplications.createdAt))
			.all()
			.map(({ application, setup }) => ({ application: toApplication(application), setup })),
		applied: drift
			.map(({ setup: { id, name }, drift }) => ({ setup: { id, name }, drift }))
			.sort((a, b) => compareText(a.setup.name, b.setup.name)),
	};
}

/** Every live agent, in any live repository or defined in the app. */
export const listAgents = (db: Db): Agent[] => agentsWhere(db, liveIn(agents));

/**
 * The live agents Gateweave runs that have a definition, in the order `listAgents` gives them, in
 * one join for the chat list.
 */
export function listRunnableAgents(db: Db): RunnableAgent[] {
	return db
		.select({
			id: agents.id,
			name: agents.name,
			description: agents.description,
			provider: agentDefinitions.provider,
			model: agentDefinitions.model,
		})
		.from(agents)
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.leftJoin(repositories, eq(agents.repositoryId, repositories.id))
		.where(and(eq(agents.runtime, "gateweave"), liveIn(agents)))
		.orderBy(asc(agents.name), asc(agents.key))
		.all();
}

/** A live agent with its repository, what it reads and, if Gateweave runs it, its definition. */
export function getAgent(db: Db, id: string): AgentDetail | null {
	const agent = agentsWhere(db, and(eq(agents.id, id), liveIn(agents)))[0];
	if (!agent) return null;
	const repository = agent.repositoryId
		? (db
				.select({ id: repositories.id, owner: repositories.owner, name: repositories.name })
				.from(repositories)
				.where(eq(repositories.id, agent.repositoryId))
				.get() ?? null)
		: null;
	const read = db
		.select({ asset: assets })
		.from(agentAssets)
		.innerJoin(assets, eq(agentAssets.assetId, assets.id))
		.leftJoin(repositories, eq(assets.repositoryId, repositories.id))
		.where(and(eq(agentAssets.agentId, id), liveIn(assets)))
		.orderBy(asc(assets.key))
		.all()
		.map(({ asset }) => toAsset(asset));

	const row = db.select().from(agentDefinitions).where(eq(agentDefinitions.agentId, id)).get();
	if (!row) return { agent, repository, assets: read, definition: null, instructions: [] };
	const pinned = pinnedAsset(db, row.instructionsAssetId, row.instructionsVersion);
	const definition: AgentDefinition = {
		provider: row.provider,
		model: row.model,
		instructions: pinned,
		environment: pinnedAsset(db, row.envSetAssetId, row.envSetVersion),
	};
	const instructions = pinned
		? (getAssetVersion(db, pinned.asset.id, pinned.version)?.files ?? [])
		: [];
	return { agent, repository, assets: read, definition, instructions };
}

/** A library asset an agent has pinned, or null when it pins none. */
function pinnedAsset(db: Db, assetId: string | null, version: number | null): PinnedAsset | null {
	if (assetId === null || version === null) return null;
	const row = db.select().from(assets).where(eq(assets.id, assetId)).get();
	return row ? { asset: toAsset(row), version, removed: row.removedAt !== null } : null;
}

/** Agents matching `where`, which may refer to their repository, with the assets they read. */
function agentsWhere(db: Db, where: SQL | undefined): Agent[] {
	const links = groupBy(
		db
			.select({ agentId: agentAssets.agentId, assetId: agentAssets.assetId })
			.from(agentAssets)
			.innerJoin(agents, eq(agentAssets.agentId, agents.id))
			.innerJoin(assets, eq(agentAssets.assetId, assets.id))
			.leftJoin(repositories, eq(agents.repositoryId, repositories.id))
			.where(where)
			.orderBy(asc(assets.key))
			.all()
			.map((link) => [link.agentId, link.assetId] as const),
	);
	return db
		.select({ agent: agents })
		.from(agents)
		.leftJoin(repositories, eq(agents.repositoryId, repositories.id))
		.where(where)
		.orderBy(asc(agents.name), asc(agents.key))
		.all()
		.map(({ agent }) => toAgent(agent, links.get(agent.id) ?? []));
}

/** One version of an asset with its files' text; the current one unless `version` is given. */
export function getAssetVersion(db: Db, assetId: string, version?: number): AssetVersion | null {
	const asset = db
		.select({ version: assets.version })
		.from(assets)
		.where(eq(assets.id, assetId))
		.get();
	if (!asset) return null;
	const row = db
		.select()
		.from(assetVersions)
		.where(
			and(eq(assetVersions.assetId, assetId), eq(assetVersions.version, version ?? asset.version)),
		)
		.get();
	if (!row) return null;
	const files = row.files.map(
		(file): AssetFile => ({
			...file,
			content:
				db.select({ content: blobs.content }).from(blobs).where(eq(blobs.id, file.blob)).get()
					?.content ?? null,
		}),
	);
	return { ...row, files };
}

/** A live asset with its repository, the agents that read it and one version's files. */
export function getAsset(db: Db, assetId: string, version?: number): AssetDetail | null {
	const row = db
		.select({ asset: assets })
		.from(assets)
		.leftJoin(repositories, eq(assets.repositoryId, repositories.id))
		.where(and(eq(assets.id, assetId), liveIn(assets)))
		.get()?.asset;
	if (!row) return null;
	const files = getAssetVersion(db, assetId, version);
	if (!files) return null;
	// A subquery, not a list of ids: it binds one parameter however many agents read the asset.
	const readers = db
		.select({ id: agentAssets.agentId })
		.from(agentAssets)
		.where(eq(agentAssets.assetId, assetId));
	const sameContent = db
		.select({ n: count() })
		.from(assets)
		.innerJoin(repositories, eq(assets.repositoryId, repositories.id))
		.where(and(eq(assets.hash, row.hash), ne(assets.id, assetId), liveIn(assets)))
		.get();
	const inRepository = row.repositoryId !== null;
	return {
		asset: toAsset(row),
		repository: row.repositoryId
			? (repositoriesWhere(db, eq(repositories.id, row.repositoryId))[0] ?? null)
			: null,
		agents: agentsWhere(db, and(liveIn(agents), inArray(agents.id, readers))),
		version: files,
		versions: db
			.select({
				version: assetVersions.version,
				hash: assetVersions.hash,
				commit: assetVersions.commit,
				createdAt: assetVersions.createdAt,
			})
			.from(assetVersions)
			.where(eq(assetVersions.assetId, assetId))
			.orderBy(desc(assetVersions.version))
			.all(),
		sameContent: sameContent?.n ?? 0,
		uses: inRepository ? [] : libraryUses(db, assetId),
		library: inRepository ? libraryMatches(db, row.hash) : [],
	};
}

const inLibrary = and(isNull(assets.repositoryId), isNull(assets.removedAt));

/**
 * Each content of a library asset by its version. A content it had twice counts as the later
 * version, since that is the one a repository would be compared with.
 */
function versionsByHash(db: Db, libraryAssetId: string): Map<string, number> {
	const versions = new Map<string, number>();
	for (const { hash, version } of db
		.select({ hash: assetVersions.hash, version: assetVersions.version })
		.from(assetVersions)
		.where(eq(assetVersions.assetId, libraryAssetId))
		.all()) {
		versions.set(hash, Math.max(versions.get(hash) ?? 0, version));
	}
	return versions;
}

/** The repository assets whose content is one of a library asset's versions. */
function libraryUses(db: Db, libraryAssetId: string): LibraryUse[] {
	const hashes = db
		.select({ hash: assetVersions.hash })
		.from(assetVersions)
		.where(eq(assetVersions.assetId, libraryAssetId));
	const rows = db
		.select({ asset: assets })
		.from(assets)
		.innerJoin(repositories, eq(assets.repositoryId, repositories.id))
		.where(and(isNull(assets.removedAt), liveRepository, inArray(assets.hash, hashes)))
		.orderBy(asc(repositories.owner), asc(repositories.name), asc(assets.key))
		.all();
	const holders = db
		.select({ id: assets.repositoryId })
		.from(assets)
		.where(and(isNotNull(assets.repositoryId), inArray(assets.hash, hashes)));
	const byId = new Map(
		repositoriesWhere(db, inArray(repositories.id, holders)).map((repository) => [
			repository.id,
			repository,
		]),
	);
	const versions = versionsByHash(db, libraryAssetId);
	return rows.flatMap(({ asset }) => {
		const repository = asset.repositoryId ? byId.get(asset.repositoryId) : undefined;
		const version = versions.get(asset.hash);
		return repository && version ? [{ asset: toAsset(asset), repository, version }] : [];
	});
}

/** The library assets that have, as one of their versions, the content with this hash. */
function libraryMatches(db: Db, hash: string): { asset: Asset; version: number }[] {
	const matches = new Map<string, { asset: Asset; version: number }>();
	for (const { asset, version } of db
		.select({ asset: assets, version: assetVersions.version })
		.from(assetVersions)
		.innerJoin(assets, eq(assetVersions.assetId, assets.id))
		.where(and(inLibrary, eq(assetVersions.hash, hash)))
		.orderBy(asc(assets.name))
		.all()) {
		const known = matches.get(asset.id);
		if (!known || known.version < version)
			matches.set(asset.id, { asset: toAsset(asset), version });
	}
	return [...matches.values()];
}

/** Every setup by name, with how many assets it pins and how many of those have a newer version. */
export function listSetups(db: Db): SetupEntry[] {
	const pins = db
		.select({
			setupId: setupAssets.setupId,
			version: setupAssets.version,
			latest: assets.version,
			removedAt: assets.removedAt,
		})
		.from(setupAssets)
		.innerJoin(assets, eq(setupAssets.assetId, assets.id))
		.all();
	const bySetup = groupBy(pins.map((pin) => [pin.setupId, pin] as const));
	return db
		.select()
		.from(setups)
		.orderBy(asc(setups.name), asc(setups.createdAt))
		.all()
		.map((row) => {
			const pinned = bySetup.get(row.id) ?? [];
			return {
				setup: toSetup(row),
				assets: pinned.length,
				updates: pinned.filter((pin) => pin.removedAt === null && pin.version < pin.latest).length,
			};
		});
}

/** A setup with its pinned assets and the files it would write, which the writers produce. */
export function getSetup(db: Db, id: string): SetupDetail | null {
	const row = db.select().from(setups).where(eq(setups.id, id)).get();
	if (!row) return null;
	const { pinned, written } = writeSetup(db, row);
	return {
		setup: toSetup(row),
		assets: pinned.map(({ asset, version }) => ({
			asset: toAsset(asset),
			version,
			removed: asset.removedAt !== null,
		})),
		files: written.files,
		problems: written.problems,
		applications: db
			.select({
				application: setupApplications,
				repository: { id: repositories.id, owner: repositories.owner, name: repositories.name },
			})
			.from(setupApplications)
			.innerJoin(repositories, eq(setupApplications.repositoryId, repositories.id))
			.where(eq(setupApplications.setupId, id))
			.orderBy(desc(setupApplications.createdAt))
			.all()
			.map(({ application, repository }) => ({
				application: toApplication(application),
				repository,
			})),
		applied: readDriftOf(db, { setupId: id })
			.map(({ repository: { id, owner, name }, drift }) => ({
				repository: { id, owner, name },
				drift,
			}))
			.sort((a, b) =>
				compareText(
					`${a.repository.owner}/${a.repository.name}`,
					`${b.repository.owner}/${b.repository.name}`,
				),
			),
	};
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A setup's pins, and the files its pinned versions write. */
export function writeSetup(db: Db, setup: SetupRow) {
	const pinned = db
		.select({ asset: assets, version: setupAssets.version })
		.from(setupAssets)
		.innerJoin(assets, eq(setupAssets.assetId, assets.id))
		.where(eq(setupAssets.setupId, setup.id))
		.orderBy(asc(assets.kind), asc(assets.name))
		.all();
	const toWrite = pinned.flatMap(({ asset, version }): AssetToWrite[] => {
		const content = getAssetVersion(db, asset.id, version);
		if (!content) return [];
		const files = content.files.map(({ path, content }) => ({ path, content }));
		const { kind, name, description, metadata } = asset;
		return [{ kind, name, description, metadata, files }];
	});
	return { pinned, written: writeAssets(toWrite, setup.runtimes) };
}

/** Every library asset, by kind and name, with how many repository assets carry it. */
export function listLibrary(db: Db): LibraryEntry[] {
	const rows = db
		.select()
		.from(assets)
		.where(inLibrary)
		.orderBy(asc(assets.kind), asc(assets.name))
		.all();
	const used = alias(assets, "used");
	// One row per library version and repository asset with its content.
	const links = db
		.select({ libraryId: assets.id, version: assetVersions.version, useId: used.id })
		.from(assetVersions)
		.innerJoin(assets, eq(assetVersions.assetId, assets.id))
		.innerJoin(used, eq(used.hash, assetVersions.hash))
		.innerJoin(repositories, eq(used.repositoryId, repositories.id))
		.where(and(inLibrary, isNull(used.removedAt), liveRepository))
		.all();
	const uses = new Map<string, Map<string, number>>();
	for (const { libraryId, version, useId } of links) {
		const byUse = uses.get(libraryId) ?? new Map<string, number>();
		byUse.set(useId, Math.max(byUse.get(useId) ?? 0, version));
		uses.set(libraryId, byUse);
	}
	return rows.map((row) => {
		const versions = [...(uses.get(row.id)?.values() ?? [])];
		return {
			asset: toAsset(row),
			uses: versions.length,
			behind: versions.filter((version) => version < row.version).length,
		};
	});
}
