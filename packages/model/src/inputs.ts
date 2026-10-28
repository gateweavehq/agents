/**
 * What the registry accepts: repositories from a connection, the result of scanning one, and the
 * projects, library and setups people manage. The registry validates every call against these, so a scanner or a
 * gateway with a bug cannot store something the pages would choke on.
 */
import { z } from "zod";
import {
	ASSET_KINDS,
	MODEL_PROVIDERS,
	REPOSITORY_PROVIDERS,
	REPOSITORY_RUNTIMES,
	RUN_STATUSES,
	TEAM_EDGE_KINDS,
	TEAM_MEMBER_KINDS,
} from "./vocabulary";

/** A path inside a repository: relative, with forward slashes and no `.` or `..` segments. */
export const repositoryPath = z
	.string()
	.min(1)
	.max(1024)
	.refine(isRepositoryPath, "Must be a relative path inside the repository");

function isRepositoryPath(path: string): boolean {
	if (path.includes("\\") || path.includes("\0")) return false;
	return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A Git object id (SHA-1), as GitHub reports commits and blobs. */
export const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/, "Must be a Git object id");

/**
 * Fields an adapter read from a file, such as a skill's front matter or an MCP server's command,
 * for showing and searching. Flat on purpose: the whole configuration is in the files, and an
 * environment's values never belong here, only their names.
 */
export const metadata = z
	.record(
		z.string().min(1).max(100),
		z.union([
			z.string().max(2000),
			z.number(),
			z.boolean(),
			z.null(),
			z.array(z.string().max(500)).max(200),
		]),
	)
	.refine((fields) => Object.keys(fields).length <= 50, "At most 50 fields");
export type Metadata = z.infer<typeof metadata>;

export const repositoryInput = z.object({
	provider: z.enum(REPOSITORY_PROVIDERS),
	/** The provider's own id, which survives renames and transfers. */
	externalId: z.string().min(1).max(100),
	/** The GitHub App installation that reaches it, which the registry scans it through. */
	installationId: z.string().min(1).max(100),
	owner: z.string().min(1).max(100),
	name: z.string().min(1).max(100),
	defaultBranch: z.string().min(1).max(255),
	private: z.boolean(),
});
export type RepositoryInput = z.infer<typeof repositoryInput>;

/** Longest file text a scan may carry. Agent configuration is far smaller. */
export const MAX_FILE_LENGTH = 1_000_000;

/**
 * One file of an asset. Binary and very large files can be given by `blob` and `size` alone,
 * which is enough to see that they changed.
 */
export const scannedFile = z
	.object({
		/**
		 * Relative to the asset's directory: the asset's `path` when it is a directory, such as a
		 * skill, and that path's parent when it is a file. The same skill or `CLAUDE.md` in two
		 * repositories then has the same files, wherever it sits. A plugin at the repository root
		 * is the exception; see `repositoryPathOf`.
		 */
		path: repositoryPath,
		content: z.string().max(MAX_FILE_LENGTH).optional(),
		/** Git's id for the content. The registry checks it when `content` is given too. */
		blob: gitObjectId.optional(),
		/** In bytes. */
		size: z.number().int().nonnegative().optional(),
	})
	.refine(
		(file) => file.content !== undefined || (file.blob !== undefined && file.size !== undefined),
		"A file needs its content, or its blob and size",
	);
export type ScannedFile = z.infer<typeof scannedFile>;

/**
 * A file a scan read, as the repository's tree has it: every file an adapter wants, which
 * includes every file a setup writes. Drift compares them with what a setup wrote there.
 */
export const scannedTreeFile = z.object({
	path: repositoryPath,
	blob: gitObjectId,
	/** In bytes. */
	size: z.number().int().nonnegative(),
	/** A symlink's blob holds the path it points to. */
	symlink: z.boolean(),
	/** The text, when the scan read it. The registry checks it against `blob`. */
	content: z.string().max(MAX_FILE_LENGTH).optional(),
});
export type ScannedTreeFile = z.infer<typeof scannedTreeFile>;

/** Most files one scan may list. Agent configuration is far smaller. */
export const MAX_SCANNED_FILES = 10_000;

export const detectedAsset = z.object({
	kind: z.enum(ASSET_KINDS),
	/**
	 * Identifies the asset across scans of one repository: its path, or a path and a name for
	 * part of a file, such as `.mcp.json#github` for one server.
	 */
	key: z.string().min(1).max(1200),
	name: z.string().min(1).max(200),
	description: z.string().max(2000).nullable(),
	/** The file or directory it was read from. */
	path: repositoryPath,
	/** What it is made of. For part of a file, the part's own text under the file's name. */
	files: z.array(scannedFile).min(1).max(500),
	metadata,
});
export type DetectedAsset = z.infer<typeof detectedAsset>;

export const detectedAgent = z.object({
	runtime: z.enum(REPOSITORY_RUNTIMES),
	/**
	 * Identifies the agent across scans, together with `runtime`: `main` for the coding agent
	 * itself, or the path of a subagent's definition.
	 */
	key: z.string().min(1).max(1200),
	name: z.string().min(1).max(200),
	description: z.string().max(2000).nullable(),
	model: z.string().max(200).nullable(),
	/** The file that defines it, if one does. */
	path: repositoryPath.nullable(),
	metadata,
	/** Keys of the assets in the same scan that this agent reads. */
	assets: z.array(z.string()).max(5000),
});
export type DetectedAgent = z.infer<typeof detectedAgent>;

/**
 * Something a scan could not read, such as a settings file that is not valid JSON. `path` is null
 * for a problem with the repository as a whole, such as a tree too large to read whole.
 */
export const scanProblem = z.object({
	path: repositoryPath.nullable(),
	message: z.string().min(1).max(500),
});
export type ScanProblem = z.infer<typeof scanProblem>;

/** Everything one scan found in a repository at one commit. */
export const scanResult = z
	.object({
		commit: gitObjectId,
		/** When the scanner read the repository. A scan older than the last one applied is ignored. */
		scannedAt: z.number().int().nonnegative(),
		agents: z.array(detectedAgent).max(500),
		assets: z.array(detectedAsset).max(5000),
		problems: z.array(scanProblem).max(100),
		files: z.array(scannedTreeFile).max(MAX_SCANNED_FILES),
	})
	.superRefine((scan, ctx) => {
		const filePaths = new Set<string>();
		for (const [index, file] of scan.files.entries()) {
			if (filePaths.has(file.path)) {
				ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: "Duplicate path" });
			}
			filePaths.add(file.path);
		}
		const assetKeys = new Set<string>();
		for (const [index, asset] of scan.assets.entries()) {
			if (assetKeys.has(asset.key)) {
				ctx.addIssue({ code: "custom", path: ["assets", index, "key"], message: "Duplicate key" });
			}
			assetKeys.add(asset.key);
			const paths = new Set<string>();
			for (const [at, file] of asset.files.entries()) {
				if (paths.has(file.path)) {
					ctx.addIssue({
						code: "custom",
						path: ["assets", index, "files", at, "path"],
						message: "Duplicate path",
					});
				}
				paths.add(file.path);
			}
		}
		const agentKeys = new Set<string>();
		for (const [index, agent] of scan.agents.entries()) {
			const key = `${agent.runtime}\0${agent.key}`;
			if (agentKeys.has(key)) {
				ctx.addIssue({ code: "custom", path: ["agents", index, "key"], message: "Duplicate key" });
			}
			agentKeys.add(key);
			for (const [at, assetKey] of agent.assets.entries()) {
				if (!assetKeys.has(assetKey)) {
					ctx.addIssue({
						code: "custom",
						path: ["agents", index, "assets", at],
						message: "No asset in this scan has this key",
					});
				}
			}
		}
	});
export type ScanResult = z.infer<typeof scanResult>;

export const projectInput = z.object({
	name: z.string().trim().min(1).max(100),
	description: z
		.string()
		.trim()
		.max(2000)
		.nullable()
		.transform((description) => description || null),
});
export type ProjectInput = z.input<typeof projectInput>;

export const projectPatch = projectInput.partial();
export type ProjectPatch = z.input<typeof projectPatch>;

/**
 * Where "Add to library" puts a repository asset: a new library asset with this name, or a new
 * version of a library asset of the same kind.
 */
export const libraryTarget = z.union([
	z.object({ name: z.string().trim().min(1).max(200) }),
	z.object({ libraryAssetId: z.string().min(1).max(64) }),
]);
export type LibraryTarget = z.input<typeof libraryTarget>;

/**
 * Most characters of text a person may write or save in the app. The registry keeps text of up to
 * 256 KiB; a character takes at least one byte, so the registry also checks the bytes.
 */
export const MAX_WRITTEN_LENGTH = 256 * 1024;

/** The kinds a person can write in the app: one text file each. */
export const WRITTEN_ASSET_KINDS = ["instructions", "prompt", "skill"] as const;

/** An asset typed into the library, with no repository behind it. */
export const writtenAssetInput = z.object({
	kind: z.enum(WRITTEN_ASSET_KINDS),
	name: z.string().trim().min(1).max(200),
	text: z.string().min(1).max(MAX_WRITTEN_LENGTH),
});
export type WrittenAssetInput = z.input<typeof writtenAssetInput>;

/** New text for some files of a library asset; the files not listed keep their text. */
export const libraryEditInput = z.object({
	libraryAssetId: z.string().min(1).max(64),
	files: z
		.array(z.object({ path: repositoryPath, content: z.string().max(MAX_WRITTEN_LENGTH) }))
		.min(1)
		.max(500)
		.refine(
			(files) => new Set(files.map((file) => file.path)).size === files.length,
			"A file is listed twice",
		),
});
export type LibraryEditInput = z.input<typeof libraryEditInput>;
export const setupInput = projectInput.extend({
	/** The coding agents it configures, kept in the order of `REPOSITORY_RUNTIMES`. */
	runtimes: z
		.array(z.enum(REPOSITORY_RUNTIMES))
		.min(1, "Choose at least one coding agent")
		.max(REPOSITORY_RUNTIMES.length)
		.transform((chosen) => REPOSITORY_RUNTIMES.filter((runtime) => chosen.includes(runtime))),
});
export type SetupInput = z.input<typeof setupInput>;

/** A setup's library assets, each pinned to one of its versions. */
export const setupPins = z
	.array(
		z.object({
			assetId: z.string().min(1).max(64),
			version: z.number().int().positive(),
		}),
	)
	.max(200)
	.refine(
		(pins) => new Set(pins.map((pin) => pin.assetId)).size === pins.length,
		"An asset can be pinned once",
	);
export type SetupPins = z.input<typeof setupPins>;

/**
 * A setup kept as plain files: this is its `setup.json`, next to the files of its assets.
 * Ready-made setups ship this way, and the CLI reads one from disk.
 */
export const setupManifest = setupInput
	.extend({
		description: z.string().trim().max(2000).nullable().default(null),
		assets: z
			.array(
				z.object({
					kind: z.enum(ASSET_KINDS),
					name: z.string().trim().min(1).max(200),
					description: z.string().trim().max(2000).nullable().default(null),
					/**
					 * A file or a folder, relative to `setup.json`. A folder's files keep their paths
					 * below it, as a skill's do; a file stands alone under its own name.
					 */
					path: repositoryPath,
					metadata: metadata.default({}),
				}),
			)
			.min(1)
			.max(200),
	})
	.superRefine((manifest, ctx) => {
		const seen = new Set<string>();
		for (const [index, asset] of manifest.assets.entries()) {
			const key = `${asset.kind}\0${asset.name}`;
			if (seen.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["assets", index, "name"],
					message: `Another ${asset.kind} is named ${asset.name}`,
				});
			}
			seen.add(key);
		}
	});
export type SetupManifest = z.infer<typeof setupManifest>;

/**
 * A setup to add to the library and create in one step, with its assets' files: what a ready-made
 * setup folder holds once it is read. Each asset becomes a library asset, or a version of the one
 * with the same kind and name, and the setup pins those versions.
 */
export const setupImportInput = setupInput
	.extend({
		description: z
			.string()
			.trim()
			.max(2000)
			.nullable()
			.default(null)
			.transform((description) => description || null),
		assets: z
			.array(
				z.object({
					kind: z.enum(ASSET_KINDS),
					name: z.string().trim().min(1).max(200),
					description: z
						.string()
						.trim()
						.max(2000)
						.nullable()
						.default(null)
						.transform((description) => description || null),
					metadata: metadata.default({}),
					files: z
						.array(z.object({ path: repositoryPath, content: z.string().max(MAX_WRITTEN_LENGTH) }))
						.min(1)
						.max(500)
						.refine(
							(files) => new Set(files.map((file) => file.path)).size === files.length,
							"A file is listed twice",
						),
				}),
			)
			.min(1)
			.max(200),
	})
	.superRefine((input, ctx) => {
		const seen = new Set<string>();
		for (const [index, asset] of input.assets.entries()) {
			const key = `${asset.kind}\0${asset.name}`;
			if (seen.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["assets", index, "name"],
					message: `Another ${asset.kind} is named ${asset.name}`,
				});
			}
			seen.add(key);
		}
	});
export type SetupImportInput = z.input<typeof setupImportInput>;

/** Most members a team has, and most edges between them. */
export const MAX_TEAM_MEMBERS = 50;
export const MAX_TEAM_EDGES = 200;

const memberId = z.string().min(1).max(64);

/** A team's name and description. */
export const teamInput = projectInput;
export type TeamInput = z.input<typeof teamInput>;

/** A new team, with the agent run by Gateweave that leads it and is its first member. */
export const newTeamInput = teamInput.extend({ lead: memberId });
export type NewTeamInput = z.input<typeof newTeamInput>;

/**
 * Who is in a team and who may reach whom. The lead is one of its agents. A member is named by
 * its id, an agent's or a team's, and an edge goes from one member to another.
 */
export const teamGraphInput = z
	.object({
		lead: memberId,
		members: z
			.array(z.object({ kind: z.enum(TEAM_MEMBER_KINDS), id: memberId }))
			.min(1)
			.max(MAX_TEAM_MEMBERS, `A team can have up to ${MAX_TEAM_MEMBERS} members`)
			.refine(
				(members) => new Set(members.map((member) => member.id)).size === members.length,
				"A member is listed twice",
			),
		edges: z
			.array(z.object({ from: memberId, to: memberId, kind: z.enum(TEAM_EDGE_KINDS) }))
			.max(MAX_TEAM_EDGES, `A team can have up to ${MAX_TEAM_EDGES} edges`)
			.refine(
				(edges) =>
					new Set(edges.map((edge) => `${edge.from} ${edge.to} ${edge.kind}`)).size ===
					edges.length,
				"An edge is listed twice",
			),
	})
	.superRefine(({ lead, members, edges }, ctx) => {
		const kinds = new Map(members.map((member) => [member.id, member.kind]));
		if (kinds.get(lead) !== "agent") {
			ctx.addIssue({
				code: "custom",
				path: ["lead"],
				message: "The lead is one of the team's agents",
			});
		}
		for (const edge of edges) {
			if (edge.from === edge.to) {
				ctx.addIssue({
					code: "custom",
					path: ["edges"],
					message: "An edge goes from one member to another",
				});
			} else if (!kinds.has(edge.from) || !kinds.has(edge.to)) {
				ctx.addIssue({
					code: "custom",
					path: ["edges"],
					message: "An edge goes between members of the team",
				});
			}
		}
	});
export type TeamGraphInput = z.input<typeof teamGraphInput>;

/**
 * A model provider's key, as an owner or admin pastes it. Keys are printable ASCII with no
 * spaces; trimming forgives the newline a copy often brings along.
 */
export const providerKeyInput = z.object({
	provider: z.enum(MODEL_PROVIDERS),
	key: z
		.string()
		.trim()
		.min(8, "That is too short to be a key")
		.max(1000, "That is too long to be a key")
		.regex(/^[\x21-\x7e]+$/, "A key has no spaces or special characters"),
});
export type ProviderKeyInput = z.input<typeof providerKeyInput>;

/** Most MCP servers one agent run by Gateweave uses. */
export const MAX_AGENT_MCP_SERVERS = 10;

/**
 * An agent defined in the app and run by Gateweave: the model it calls with the workspace's key
 * for that provider, and what it always reads, a library asset pinned to a version (one of
 * `INSTRUCTION_KINDS`).
 */
export const agentDefinitionInput = projectInput.extend({
	provider: z.enum(MODEL_PROVIDERS),
	/** The provider's id for the model, as its models API lists it. */
	model: z
		.string()
		.trim()
		.min(1, "Choose a model")
		.max(200)
		.regex(/^[\x21-\x7e]+$/, "A model id has no spaces or special characters"),
	instructions: z
		.object({ assetId: z.string().min(1).max(64), version: z.number().int().positive() })
		.nullable(),
	/** An environment set (an `env-set` library asset) pinned to a version; none by default. */
	environment: z
		.object({ assetId: z.string().min(1).max(64), version: z.number().int().positive() })
		.nullable()
		.default(null),
	/** MCP servers (`mcp-server` library assets) whose tools it uses, each pinned to a version. */
	mcpServers: z
		.array(z.object({ assetId: z.string().min(1).max(64), version: z.number().int().positive() }))
		.max(MAX_AGENT_MCP_SERVERS, `An agent can use up to ${MAX_AGENT_MCP_SERVERS} MCP servers`)
		.refine(
			(pins) => new Set(pins.map((pin) => pin.assetId)).size === pins.length,
			"An MCP server is chosen twice",
		)
		.default([]),
});
export type AgentDefinitionInput = z.input<typeof agentDefinitionInput>;

/** The one file of an MCP server written in the app, in the format Claude Code reads. */
export const MCP_SERVER_FILE = ".mcp.json";

/**
 * A header value that names a variable of the agent's environment set, with any text before it:
 * `Bearer ${API_TOKEN}`. A header never holds a secret itself, so none lands in a file.
 */
export const MCP_HEADER_VALUE = /^[^$]*\$\{[A-Z_][A-Z0-9_]*\}$/;

/** A plain-HTTP address on the machine itself, for local development. */
const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/;

/**
 * A remote MCP server's address: https, or http on the machine itself. Credentials and settings
 * go in headers, so it has no user, query or fragment.
 */
export const mcpServerUrl = z
	.string()
	.trim()
	.max(2000)
	.pipe(
		z.url({
			protocol: /^https?$/,
			normalize: true,
			error: "Enter the server's full URL, starting with https://",
		}),
	)
	.refine(
		(url) => url.startsWith("https://") || LOOPBACK.test(url),
		"The URL must start with https://",
	)
	.refine(
		(url) => !/^[a-z]+:\/\/[^/]*@/i.test(url) && !/[?#]/.test(url),
		"Send credentials and settings as headers, not in the URL",
	);

/** An MCP server written in the app: reached over the network, so an agent run by Gateweave can use it. */
export const mcpServerInput = z.object({
	name: z.string().trim().min(1).max(200),
	transport: z.enum(["http", "sse"]),
	url: mcpServerUrl,
	headers: z
		.array(
			z.object({
				name: z
					.string()
					.trim()
					.min(1)
					.max(100)
					.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "A header's name has no spaces or symbols"),
				value: z
					.string()
					.trim()
					.max(1000)
					// biome-ignore lint/suspicious/noTemplateCurlyInString: the reference people write
					.regex(MCP_HEADER_VALUE, "A header's value names a variable, as in Bearer ${API_TOKEN}"),
			}),
		)
		.max(20)
		.refine(
			(headers) =>
				new Set(headers.map((header) => header.name.toLowerCase())).size === headers.length,
			"A header is set twice",
		)
		.default([]),
});
export type McpServerInput = z.input<typeof mcpServerInput>;

/**
 * New settings for an MCP server in the library; saved as its next version if they differ. Its
 * name stays: the name is how setups write it and how its tools are named.
 */
export const mcpServerEditInput = mcpServerInput
	.omit({ name: true })
	.extend({ assetId: z.string().min(1).max(64) });
export type McpServerEditInput = z.input<typeof mcpServerEditInput>;

/** The one file of an environment set, as the library stores it. */
export const ENV_FILE = "environment.json";

/** Most variables and secrets one environment set may hold, together. */
export const MAX_ENV_ENTRIES = 200;

/** Longest value, in characters, of a variable or a secret. */
export const MAX_ENV_VALUE_LENGTH = 10_000;

/** An environment variable's name, as shells and runtimes read it. */
export const envName = z
	.string()
	.max(100)
	.regex(
		/^[A-Z_][A-Z0-9_]*$/,
		"Names use capital letters, digits and underscores, and do not start with a digit",
	);

/**
 * What an environment set holds, as `environment.json` has it: variables with their values, and
 * the names of the secrets whose values live sealed in the registry, never in the file. A name is
 * a variable or a secret, not both.
 */
export const envSetContent = z
	.object({
		variables: z.record(envName, z.string().max(MAX_ENV_VALUE_LENGTH)),
		secrets: z.array(envName),
	})
	.superRefine((content, ctx) => {
		const names = Object.keys(content.variables);
		if (names.length + content.secrets.length > MAX_ENV_ENTRIES) {
			ctx.addIssue({
				code: "custom",
				message: `At most ${MAX_ENV_ENTRIES} variables and secrets`,
			});
		}
		const seen = new Set(names);
		for (const [index, name] of content.secrets.entries()) {
			if (seen.has(name)) {
				ctx.addIssue({
					code: "custom",
					path: ["secrets", index],
					message: `${name} is listed twice: a name is a variable or a secret`,
				});
			}
			seen.add(name);
		}
	});
export type EnvSetContent = z.infer<typeof envSetContent>;

/** A new environment set: a library asset of kind `env-set`. */
export const envSetInput = envSetContent.and(z.object({ name: z.string().trim().min(1).max(200) }));
export type EnvSetInput = z.input<typeof envSetInput>;

/** New content for an environment set; saved as its next version only if it differs. */
export const envSetEditInput = envSetContent.and(z.object({ assetId: z.string().min(1).max(64) }));
export type EnvSetEditInput = z.input<typeof envSetEditInput>;

/**
 * A secret's value, as an owner or admin types it. Only one trailing newline is dropped, the one
 * a paste often brings; spaces and other newlines may be part of the value.
 */
export const envSecretInput = z.object({
	assetId: z.string().min(1).max(64),
	name: envName,
	value: z
		.string()
		.transform((value) => value.replace(/\r?\n$/, ""))
		.pipe(z.string().min(1, "A value cannot be empty").max(MAX_ENV_VALUE_LENGTH)),
});
export type EnvSecretInput = z.input<typeof envSecretInput>;

const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** How a run ended, as the runtime reports it to the registry. */
export const runFinish = z.object({
	status: z.enum(RUN_STATUSES).exclude(["running"]),
	/** Why it failed, in the app's words; never a provider's message. */
	error: z.string().max(500).nullable(),
	/** Model requests it made. */
	steps: z.number().int().min(0).max(10_000),
	inputTokens: tokenCount,
	outputTokens: tokenCount,
	/** Input read from the provider's cache, counted in `inputTokens` too. */
	cachedInputTokens: tokenCount,
	/** Estimated cost in millionths of a dollar; null when a model it used has no prices. */
	cost: tokenCount.nullable(),
	endedAt: z.number().int().positive(),
});
export type RunFinish = z.input<typeof runFinish>;

/** Most runs one page of the Runs list shows. */
export const RUNS_PER_PAGE = 50;

/** Where a page of runs starts: right after this run, in the list's order. */
export const runCursor = z.object({
	startedAt: z.number().int().positive(),
	id: z.string().min(1).max(64),
});
export type RunCursor = z.infer<typeof runCursor>;

/**
 * How far one message to a team can go: how deep turns nest below the turn the message started,
 * how many turns one turn may start, and how many the message leads to in all. They keep a team
 * from running away with the workspace's keys, since reports may go in a circle.
 */
export const TEAM_TURN_LIMITS = { depth: 4, perTurn: 8, perMessage: 32 };

/** The edge a nested turn comes through, as the turn that takes it asks for it. */
export const turnVia = z.object({
	parentRunId: z.string().min(1).max(64),
	/** The caller's span for the call, which the nested run points back to. */
	parentSpanId: z.string().min(1).max(64),
	kind: z.enum(TEAM_EDGE_KINDS),
	/** The team whose graph has the edge. */
	team: memberId,
	/** The member it goes to: an agent, or a team reached through its lead. */
	to: memberId,
});
export type TurnVia = z.input<typeof turnVia>;

/** Most tools, and the longest name and description, a check of an MCP server keeps. */
export const MCP_CHECK_LIMITS = { tools: 200, name: 200, description: 500 };

/** What checking an MCP server found: its tools, or why it could not be reached. */
export const mcpCheckResult = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		tools: z
			.array(
				z.object({
					name: z.string().max(MCP_CHECK_LIMITS.name),
					description: z.string().max(MCP_CHECK_LIMITS.description),
				}),
			)
			.max(MCP_CHECK_LIMITS.tools),
	}),
	z.object({ ok: z.literal(false), error: z.string().max(1000) }),
]);
export type McpCheckResult = z.infer<typeof mcpCheckResult>;
