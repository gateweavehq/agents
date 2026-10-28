/** What the registry returns. Times are milliseconds since the epoch. */
import type { Metadata, ScanProblem } from "./inputs";
import type { AgentRuntime, AssetKind, RepositoryProvider } from "./vocabulary";

/** A product or initiative. Groups repositories; a repository can be in several projects. */
export interface Project {
	id: string;
	name: string;
	description: string | null;
	repositoryIds: string[];
	createdAt: number;
	updatedAt: number;
}

export interface Repository {
	id: string;
	provider: RepositoryProvider;
	externalId: string;
	installationId: string | null;
	owner: string;
	name: string;
	defaultBranch: string;
	private: boolean;
	projectIds: string[];
	/** The runtimes of the agents found in it, in the order of `AGENT_RUNTIMES`. */
	runtimes: AgentRuntime[];
	/** The commit the agents and assets were read from. Null until the first scan. */
	scannedCommit: string | null;
	scannedAt: number | null;
	/** Why the last scan failed, if it did. What an earlier scan found is kept. */
	scanError: string | null;
	/** True while a scan is waiting or running. */
	scanPending: boolean;
	problems: ScanProblem[];
	createdAt: number;
	updatedAt: number;
}

export interface Agent {
	id: string;
	/** Null for an agent defined in the app rather than found in a repository. */
	repositoryId: string | null;
	runtime: AgentRuntime;
	key: string;
	name: string;
	description: string | null;
	model: string | null;
	path: string | null;
	metadata: Metadata;
	assetIds: string[];
	createdAt: number;
	updatedAt: number;
}

export interface Asset {
	id: string;
	/** Null for an asset in the library rather than found in a repository. */
	repositoryId: string | null;
	kind: AssetKind;
	key: string;
	name: string;
	description: string | null;
	path: string | null;
	metadata: Metadata;
	/** Starts at 1 and goes up each time the content changes. */
	version: number;
	/**
	 * Identifies the content: equal hashes mean the same files with the same text. This is how
	 * the registry tells whether an asset is the same everywhere or has drifted.
	 */
	hash: string;
	createdAt: number;
	updatedAt: number;
}

export interface AssetFile {
	path: string;
	/** Git's id for the content. */
	blob: string;
	size: number;
	/** Null for binary files and files too large to keep. */
	content: string | null;
}

export interface AssetVersion {
	assetId: string;
	version: number;
	hash: string;
	/** The commit it was found at, for an asset found in a repository. */
	commit: string | null;
	files: AssetFile[];
	createdAt: number;
}

export interface RepositoryDetail {
	repository: Repository;
	agents: Agent[];
	assets: Asset[];
}

/** A project with its repositories and the agents configured in them. */
export interface ProjectDetail {
	project: Project;
	repositories: Repository[];
	agents: Agent[];
}

/** A version of an asset, without its files. */
export type AssetVersionSummary = Omit<AssetVersion, "assetId" | "files">;

/** An asset with where it lives, who reads it and its history. */
export interface AssetDetail {
	asset: Asset;
	/** Null for an asset in the library. */
	repository: Repository | null;
	/** The agents that read it. */
	agents: Agent[];
	/** The version asked for, the current one by default, with its files. */
	version: AssetVersion;
	/** Every version, newest first. */
	versions: AssetVersionSummary[];
	/** Live assets elsewhere with the same content, which is how a shared skill shows. */
	sameContent: number;
}

export interface Overview {
	projects: number;
	repositories: number;
	agents: number;
	assets: number;
}
