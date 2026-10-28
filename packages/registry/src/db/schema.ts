/**
 * The registry of a single workspace. Each workspace is one Durable Object with its own SQLite
 * database, so no table needs a workspace column.
 *
 * Rows found by scanning a repository are soft-removed (`removed_at`) when a later scan no
 * longer finds them, and come back if it finds them again, so history and ids survive.
 */
import {
	AGENT_RUNTIMES,
	APPLICATION_STATES,
	ASSET_KINDS,
	type Metadata,
	MODEL_PROVIDERS,
	REPOSITORY_PROVIDERS,
	type RepositoryRuntime,
	type ScanProblem,
} from "@gateweave/agents-model";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** One file of an asset version, by its path relative to the asset. */
export interface FileEntry {
	path: string;
	blob: string;
	size: number;
}

export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const repositories = sqliteTable(
	"repositories",
	{
		id: text("id").primaryKey(),
		provider: text("provider", { enum: REPOSITORY_PROVIDERS }).notNull(),
		externalId: text("external_id").notNull(),
		/** The GitHub App installation that reaches it. */
		installationId: text("installation_id"),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		defaultBranch: text("default_branch").notNull(),
		private: integer("private", { mode: "boolean" }).notNull(),
		scannedCommit: text("scanned_commit"),
		scannedAt: integer("scanned_at"),
		scanError: text("scan_error"),
		problems: text("problems", { mode: "json" })
			.$type<ScanProblem[]>()
			.notNull()
			.default(sql`'[]'`),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		/** Set when the connection no longer reaches it. What it held is kept for when it returns. */
		removedAt: integer("removed_at"),
	},
	(table) => [
		uniqueIndex("repositories_external_idx").on(table.provider, table.externalId),
		index("repositories_installation_idx").on(table.installationId),
	],
);

/**
 * The files the last scan of a repository read: every file an adapter wants, which includes
 * every file a setup writes. Drift compares them with what a setup wrote there.
 */
export const repositoryFiles = sqliteTable(
	"repository_files",
	{
		repositoryId: text("repository_id")
			.notNull()
			.references(() => repositories.id),
		path: text("path").notNull(),
		blob: text("blob").notNull(),
		size: integer("size").notNull(),
		/** A symlink's blob holds the path it points to. */
		symlink: integer("symlink", { mode: "boolean" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.repositoryId, table.path] })],
);

export const projectRepositories = sqliteTable(
	"project_repositories",
	{
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id),
		repositoryId: text("repository_id")
			.notNull()
			.references(() => repositories.id),
	},
	(table) => [
		primaryKey({ columns: [table.projectId, table.repositoryId] }),
		index("project_repositories_repository_idx").on(table.repositoryId),
	],
);

export const agents = sqliteTable(
	"agents",
	{
		id: text("id").primaryKey(),
		/** Null for an agent defined in the app. */
		repositoryId: text("repository_id").references(() => repositories.id),
		runtime: text("runtime", { enum: AGENT_RUNTIMES }).notNull(),
		key: text("key").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		model: text("model"),
		path: text("path"),
		metadata: text("metadata", { mode: "json" }).$type<Metadata>().notNull().default(sql`'{}'`),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		removedAt: integer("removed_at"),
	},
	(table) => [
		uniqueIndex("agents_repository_key_idx").on(table.repositoryId, table.runtime, table.key),
	],
);

export const assets = sqliteTable(
	"assets",
	{
		id: text("id").primaryKey(),
		/** Null for an asset in the library. */
		repositoryId: text("repository_id").references(() => repositories.id),
		kind: text("kind", { enum: ASSET_KINDS }).notNull(),
		key: text("key").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		path: text("path"),
		/** Read from the current files, like the name and description, so not versioned. */
		metadata: text("metadata", { mode: "json" }).$type<Metadata>().notNull().default(sql`'{}'`),
		/** The current version, and its hash, copied here so drift is one indexed lookup. */
		version: integer("version").notNull(),
		hash: text("hash").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		removedAt: integer("removed_at"),
	},
	(table) => [
		uniqueIndex("assets_repository_key_idx").on(table.repositoryId, table.key),
		// The index above treats every NULL repository as different, so the library needs its own.
		uniqueIndex("assets_library_key_idx")
			.on(table.key)
			.where(sql`repository_id is null and removed_at is null`),
		index("assets_hash_idx").on(table.hash),
	],
);

/** Every content an asset has had. A new version is added only when the hash changes. */
export const assetVersions = sqliteTable(
	"asset_versions",
	{
		assetId: text("asset_id")
			.notNull()
			.references(() => assets.id),
		version: integer("version").notNull(),
		hash: text("hash").notNull(),
		commit: text("commit"),
		files: text("files", { mode: "json" }).$type<FileEntry[]>().notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.assetId, table.version] })],
);

/**
 * File contents by Git blob id, so a file shared by many repositories or versions is stored
 * once. `content` is null for binary files and files over the size the registry keeps.
 */
export const blobs = sqliteTable("blobs", {
	id: text("id").primaryKey(),
	size: integer("size").notNull(),
	content: text("content"),
});

export const agentAssets = sqliteTable(
	"agent_assets",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		assetId: text("asset_id")
			.notNull()
			.references(() => assets.id),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.assetId] }),
		index("agent_assets_asset_idx").on(table.assetId),
	],
);

export const setups = sqliteTable("setups", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	runtimes: text("runtimes", { mode: "json" }).$type<RepositoryRuntime[]>().notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/**
 * A setup's library assets, each pinned to a version. A pin moves only when someone moves it, so
 * a new version in the library never changes what a setup writes by itself.
 */
export const setupAssets = sqliteTable(
	"setup_assets",
	{
		setupId: text("setup_id")
			.notNull()
			.references(() => setups.id),
		assetId: text("asset_id")
			.notNull()
			.references(() => assets.id),
		version: integer("version").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.setupId, table.assetId] }),
		index("setup_assets_asset_idx").on(table.assetId),
	],
);

/**
 * Each pull request that applies a setup to a repository. Its state follows GitHub's
 * `pull_request` webhooks, and is checked again whenever the setup is applied there.
 */
export const setupApplications = sqliteTable(
	"setup_applications",
	{
		id: text("id").primaryKey(),
		setupId: text("setup_id")
			.notNull()
			.references(() => setups.id),
		repositoryId: text("repository_id")
			.notNull()
			.references(() => repositories.id),
		pins: text("pins", { mode: "json" }).$type<{ assetId: string; version: number }[]>().notNull(),
		files: text("files", { mode: "json" }).$type<{ path: string; blob: string }[]>().notNull(),
		branch: text("branch").notNull(),
		commit: text("commit").notNull(),
		pullNumber: integer("pull_number").notNull(),
		pullUrl: text("pull_url").notNull(),
		state: text("state", { enum: APPLICATION_STATES }).notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("setup_applications_setup_idx").on(table.setupId),
		index("setup_applications_pull_idx").on(table.repositoryId, table.pullNumber),
	],
);

/**
 * Repositories waiting for a scan, which the Durable Object's alarm works through. A repository
 * has one request at most; asking again while it waits moves it to the front.
 */
export const scanRequests = sqliteTable(
	"scan_requests",
	{
		repositoryId: text("repository_id")
			.primaryKey()
			.references(() => repositories.id),
		requestedAt: integer("requested_at").notNull(),
		/** Failed tries so far. The request is dropped after the last one. */
		attempts: integer("attempts").notNull().default(0),
		/** When the next try may start. */
		notBefore: integer("not_before").notNull(),
		/** Read the repository even if its head has not moved, as "Scan now" asks. */
		force: integer("force", { mode: "boolean" }).notNull().default(false),
	},
	(table) => [index("scan_requests_not_before_idx").on(table.notBefore)],
);

/**
 * The workspace's key for each model provider, encrypted (see `secrets.ts`). Only the runtime and
 * the key check ever decrypt it; the app sees `hint`.
 */
export const providerKeys = sqliteTable("provider_keys", {
	provider: text("provider", { enum: MODEL_PROVIDERS }).primaryKey(),
	sealed: text("sealed").notNull(),
	hint: text("hint").notNull(),
	addedBy: text("added_by").notNull(),
	addedAt: integer("added_at").notNull(),
	/** The last check: when, whether it worked, why not, and how many models it listed. */
	checkedAt: integer("checked_at"),
	checkOk: integer("check_ok", { mode: "boolean" }),
	checkMessage: text("check_message"),
	checkModels: integer("check_models"),
});

export type ProjectRow = typeof projects.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type RepositoryFileRow = typeof repositoryFiles.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type ScanRequestRow = typeof scanRequests.$inferSelect;
export type SetupRow = typeof setups.$inferSelect;
export type SetupApplicationRow = typeof setupApplications.$inferSelect;
export type ProviderKeyRow = typeof providerKeys.$inferSelect;
