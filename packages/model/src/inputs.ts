/**
 * What the registry accepts: repositories from a connection, the result of scanning one, and
 * projects people create. The registry validates every call against these, so a scanner or a
 * gateway with a bug cannot store something the pages would choke on.
 */
import { z } from "zod";
import { ASSET_KINDS, REPOSITORY_PROVIDERS, REPOSITORY_RUNTIMES } from "./vocabulary";

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
	})
	.superRefine((scan, ctx) => {
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
