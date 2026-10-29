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
	type McpTool,
	type Metadata,
	MODEL_PROVIDERS,
	REPOSITORY_PROVIDERS,
	type RepositoryRuntime,
	RUN_STATUSES,
	type ScanProblem,
	TEAM_EDGE_KINDS,
	TEAM_MEMBER_KINDS,
	TRIGGER_DELIVERY_STATUSES,
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

/**
 * How an agent run by Gateweave works. Its row in `agents` has the `gateweave` runtime, no
 * repository, and its own id as its key; its instructions are pinned like a setup's assets.
 */
export const agentDefinitions = sqliteTable(
	"agent_definitions",
	{
		agentId: text("agent_id")
			.primaryKey()
			.references(() => agents.id),
		provider: text("provider", { enum: MODEL_PROVIDERS }).notNull(),
		model: text("model").notNull(),
		instructionsAssetId: text("instructions_asset_id").references(() => assets.id),
		instructionsVersion: integer("instructions_version"),
		/** The environment set (an `env-set` library asset) it runs with, pinned like instructions. */
		envSetAssetId: text("env_set_asset_id").references(() => assets.id),
		envSetVersion: integer("env_set_version"),
	},
	(table) => [
		index("agent_definitions_instructions_idx").on(table.instructionsAssetId),
		index("agent_definitions_env_set_idx").on(table.envSetAssetId),
	],
);

/**
 * The MCP servers (`mcp-server` library assets) an agent run by Gateweave uses, each pinned to a
 * version like its instructions. The agent reads them through `agent_assets` too.
 */
export const agentMcpServers = sqliteTable(
	"agent_mcp_servers",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		assetId: text("asset_id")
			.notNull()
			.references(() => assets.id),
		version: integer("version").notNull(),
		/** The tools the agent may use, by the server's names; null is all of them. */
		tools: text("tools", { mode: "json" }).$type<string[]>(),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.assetId] }),
		index("agent_mcp_servers_asset_idx").on(table.assetId),
	],
);

/**
 * The last check of each MCP server in the library: when, against which version, whether it
 * worked, the tools it listed and why not, in the app's words. Never a header value or anything
 * the server said.
 */
export const mcpChecks = sqliteTable("mcp_checks", {
	assetId: text("asset_id")
		.primaryKey()
		.references(() => assets.id),
	version: integer("version").notNull(),
	checkedAt: integer("checked_at").notNull(),
	ok: integer("ok", { mode: "boolean" }).notNull(),
	tools: text("tools", { mode: "json" }).$type<McpTool[]>().notNull(),
	error: text("error"),
});

/** Teams of agents run by Gateweave, which can nest (see `teams.ts`). */
export const teams = sqliteTable("teams", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	/** One of its agent members: the one a chat with the team talks to. */
	leadAgentId: text("lead_agent_id")
		.notNull()
		.references(() => agents.id),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/** Who is in each team: an agent or another team, by id. Ids are UUIDs, so the two never clash. */
export const teamMembers = sqliteTable(
	"team_members",
	{
		teamId: text("team_id")
			.notNull()
			.references(() => teams.id),
		kind: text("kind", { enum: TEAM_MEMBER_KINDS }).notNull(),
		memberId: text("member_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.teamId, table.memberId] }),
		index("team_members_member_idx").on(table.memberId),
	],
);

/** Who may reach whom in each team, between the ids of two of its members. */
export const teamEdges = sqliteTable(
	"team_edges",
	{
		teamId: text("team_id")
			.notNull()
			.references(() => teams.id),
		fromId: text("from_id").notNull(),
		toId: text("to_id").notNull(),
		kind: text("kind", { enum: TEAM_EDGE_KINDS }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.teamId, table.fromId, table.toId, table.kind] })],
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

/**
 * The values of environment sets' secrets, encrypted (see `secrets.ts`). They belong to the set,
 * not to one of its versions, so moving a pin keeps them. Only the runtime decrypts one; the app
 * sees which names have a value.
 */
export const envSecrets = sqliteTable(
	"env_secrets",
	{
		assetId: text("asset_id")
			.notNull()
			.references(() => assets.id),
		name: text("name").notNull(),
		sealed: text("sealed").notNull(),
		setBy: text("set_by").notNull(),
		setAt: integer("set_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.assetId, table.name] })],
);

/**
 * Conversations with agents run by Gateweave, each private to the member who started it. The
 * messages live in the conversation's own Durable Object; this is the index pages list them from.
 */
export const conversations = sqliteTable(
	"conversations",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		/** The user id of the member who started it. */
		startedBy: text("started_by").notNull(),
		title: text("title"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		/**
		 * The team it is with, whose lead answers each turn. No foreign key: a deleted team leaves
		 * its conversations to be read.
		 */
		teamId: text("team_id"),
		/**
		 * For a turn a team's agent took over an edge, in a conversation of its own: the
		 * conversation the person started, which it goes with. Such conversations are not listed.
		 */
		rootId: text("root_id"),
		/** The trigger whose delivery started it; `started_by` names the trigger then. */
		triggerId: text("trigger_id"),
	},
	(table) => [
		index("conversations_started_by_idx").on(table.startedBy, table.updatedAt),
		index("conversations_agent_idx").on(table.agentId),
		index("conversations_root_idx").on(table.rootId),
	],
);

/**
 * Each turn of a conversation, summed up for the Runs page and the Overview. A run outlives its
 * conversation (`conversation_id` is cleared), so usage stays counted; its trace does not.
 */
export const runs = sqliteTable(
	"runs",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		conversationId: text("conversation_id"),
		/** The user id of the member whose message started it. */
		startedBy: text("started_by").notNull(),
		provider: text("provider", { enum: MODEL_PROVIDERS }).notNull(),
		model: text("model").notNull(),
		status: text("status", { enum: RUN_STATUSES }).notNull(),
		error: text("error"),
		steps: integer("steps").notNull().default(0),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
		/** Estimated cost in millionths of a dollar; null when the model has no prices. */
		cost: integer("cost"),
		startedAt: integer("started_at").notNull(),
		endedAt: integer("ended_at"),
		/** For a run another run called over a team's edge: that run, and its span for the call. */
		parentRunId: text("parent_run_id"),
		parentSpanId: text("parent_span_id"),
		/** The run of the person's message that led to this one. */
		rootRunId: text("root_run_id"),
		edge: text("edge", { enum: TEAM_EDGE_KINDS }),
		depth: integer("depth").notNull().default(0),
		/** The teams from the one the person talks to down to the one the agent acts in. */
		teamPath: text("team_path", { mode: "json" }).$type<string[]>(),
		/** The trigger whose delivery started it. No foreign key: runs outlive their trigger. */
		triggerId: text("trigger_id"),
	},
	(table) => [
		index("runs_started_at_idx").on(table.startedAt),
		index("runs_started_by_idx").on(table.startedBy, table.startedAt),
		index("runs_conversation_idx").on(table.conversationId),
		index("runs_parent_idx").on(table.parentRunId),
		index("runs_root_idx").on(table.rootRunId),
	],
);

/**
 * Inbound webhooks that start a run of an agent or a team (`../triggers.ts`). The secret is sealed
 * (see `secrets.ts`) and opened only to check a delivery's signature.
 */
export const triggers = sqliteTable(
	"triggers",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		prompt: text("prompt").notNull(),
		/** The agent it starts, or null when it starts a team. */
		agentId: text("agent_id").references(() => agents.id),
		/** The team whose lead it starts; its triggers go when the team is deleted. */
		teamId: text("team_id"),
		sealed: text("sealed").notNull(),
		secretStart: text("secret_start").notNull(),
		active: integer("active", { mode: "boolean" }).notNull(),
		perDay: integer("per_day").notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("triggers_agent_idx").on(table.agentId),
		index("triggers_team_idx").on(table.teamId),
	],
);

/**
 * What came to each trigger, by the sender's `webhook-id`: a retry of one event finds its row, and
 * the runs started in the last minute and day are counted from here.
 */
export const triggerDeliveries = sqliteTable(
	"trigger_deliveries",
	{
		triggerId: text("trigger_id")
			.notNull()
			.references(() => triggers.id),
		id: text("id").notNull(),
		status: text("status", { enum: TRIGGER_DELIVERY_STATUSES }).notNull(),
		event: text("event"),
		conversationId: text("conversation_id"),
		runId: text("run_id"),
		error: text("error"),
		receivedAt: integer("received_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.triggerId, table.id] }),
		index("trigger_deliveries_received_idx").on(table.triggerId, table.receivedAt),
		index("trigger_deliveries_conversation_idx").on(table.conversationId),
	],
);

export type ProjectRow = typeof projects.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type RepositoryFileRow = typeof repositoryFiles.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AgentDefinitionRow = typeof agentDefinitions.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type ScanRequestRow = typeof scanRequests.$inferSelect;
export type SetupRow = typeof setups.$inferSelect;
export type SetupApplicationRow = typeof setupApplications.$inferSelect;
export type ProviderKeyRow = typeof providerKeys.$inferSelect;
export type EnvSecretRow = typeof envSecrets.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type TriggerRow = typeof triggers.$inferSelect;
export type TriggerDeliveryRow = typeof triggerDeliveries.$inferSelect;
