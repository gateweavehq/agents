// Durable Object SQLite binds at most 100 parameters per query, so lists of ids are joined or
// looked up one by one rather than passed to IN (...).
import type {
	Agent,
	AssetDetail,
	AssetFile,
	AssetVersion,
	Overview,
	Project,
	Repository,
	RepositoryDetail,
} from "@gateweave/agents-model";
import { and, asc, count, desc, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import {
	agentAssets,
	agents,
	assets,
	assetVersions,
	blobs,
	projectRepositories,
	projects,
	repositories,
	scanRequests,
} from "./db/schema";
import { type Db, groupBy, toAgent, toAsset, toProject, toRepository } from "./state";

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

/** Live repositories, by owner and name, with their projects and the runtimes found in them. */
function repositoriesWhere(db: Db, where?: SQL): Repository[] {
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
	return db
		.select()
		.from(repositories)
		.where(live)
		.orderBy(asc(repositories.owner), asc(repositories.name))
		.all()
		.map((row) =>
			toRepository(row, links.get(row.id) ?? [], runtimes.get(row.id) ?? [], pending.has(row.id)),
		);
}

export const listRepositories = (db: Db): Repository[] => repositoriesWhere(db);

export function getRepository(db: Db, id: string): RepositoryDetail | null {
	const [repository] = repositoriesWhere(db, eq(repositories.id, id));
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
	};
}

/** Every live agent, in any live repository or defined in the app. */
export const listAgents = (db: Db): Agent[] => agentsWhere(db, liveIn(agents));

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
		.leftJoin(repositories, eq(assets.repositoryId, repositories.id))
		.where(and(eq(assets.hash, row.hash), ne(assets.id, assetId), liveIn(assets)))
		.get();
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
	};
}
