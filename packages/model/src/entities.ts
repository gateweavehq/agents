/** What the registry returns. Times are milliseconds since the epoch. */
import type { Metadata, ScanProblem } from "./inputs";
import type {
	AgentRuntime,
	ApplicationState,
	AssetKind,
	DriftFileState,
	DriftState,
	RepositoryProvider,
	RepositoryRuntime,
} from "./vocabulary";

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
	/** The most urgent drift among the setups applied to it; null when none was merged there. */
	drift: DriftState | null;
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
	/** The setups applied to it, newest first. */
	applications: { application: SetupApplication; setup: { id: string; name: string } }[];
	/** Each setup merged into it at least once, by name, and how the repository compares. */
	applied: { setup: { id: string; name: string }; drift: SetupDrift }[];
}

/** A project with its repositories and the agents configured in them. */
export interface ProjectDetail {
	project: Project;
	repositories: Repository[];
	agents: Agent[];
}

/** A version of an asset, without its files. */
export type AssetVersionSummary = Omit<AssetVersion, "assetId" | "files">;

/** A repository asset whose content is one version of a library asset. */
export interface LibraryUse {
	asset: Asset;
	repository: Repository;
	/** The library asset's version it matches; below the current one, the repository is behind. */
	version: number;
}

/** A library asset with how many repository assets carry one of its versions. */
export interface LibraryEntry {
	asset: Asset;
	uses: number;
	/** Of those, the ones on an older version. */
	behind: number;
}

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
	/** Live repository assets elsewhere with the same content, which is how a shared skill shows. */
	sameContent: number;
	/** For a library asset: the repository assets that carry one of its versions. */
	uses: LibraryUse[];
	/** For a repository asset: the library assets with a version of the same content. */
	library: { asset: Asset; version: number }[];
}

/** Library assets pinned to versions, for the coding agents it configures. */
export interface Setup {
	id: string;
	name: string;
	description: string | null;
	runtimes: RepositoryRuntime[];
	createdAt: number;
	updatedAt: number;
}

/** A setup with how many assets it pins, and how many of those have a newer version. */
export interface SetupEntry {
	setup: Setup;
	assets: number;
	updates: number;
}

/** One pinned asset. `asset.version` is the latest, so a lower `version` has an update. */
export interface SetupAsset {
	asset: Asset;
	version: number;
	/** True when it has left the library. The pinned version still exists and is still written. */
	removed: boolean;
}

/** A setup with its assets and what it would write into a repository. */
export interface SetupDetail {
	setup: Setup;
	assets: SetupAsset[];
	/** Relative to the repository root, sorted by path. */
	files: { path: string; content: string }[];
	/** Assets, or parts of them, that cannot be written for these coding agents, and why. */
	problems: { asset: string; message: string }[];
	/** The repositories it was applied to, newest first. */
	applications: {
		application: SetupApplication;
		repository: { id: string; owner: string; name: string };
	}[];
	/** Each live repository it was merged into at least once, by name, and how it compares. */
	applied: { repository: { id: string; owner: string; name: string }; drift: SetupDrift }[];
}

/** A setup applied to a repository: the pull request that writes its files there. */
export interface SetupApplication {
	id: string;
	setupId: string;
	repositoryId: string;
	/** The pins the pull request's files come from. */
	pins: { assetId: string; version: number }[];
	/** The files the setup owns in the repository once the pull request is merged, by blob id. */
	files: { path: string; blob: string }[];
	branch: string;
	/** The commit the pull request's branch was left at. */
	commit: string;
	pullNumber: number;
	pullUrl: string;
	state: ApplicationState;
	createdAt: number;
	updatedAt: number;
}

/**
 * How a repository compares with a setup applied to it: the files the last merged pull request
 * left the setup owning, against the last scan and against what the setup writes now.
 */
export interface SetupDrift {
	state: DriftState;
	/** The merged pull request it is compared with. */
	merged: { pullNumber: number; pullUrl: string; mergedAt: number };
	/** A later pull request for the same setup that is still open. */
	open: { pullNumber: number; pullUrl: string } | null;
	/** The files that differ, by path. Empty when in sync, and until a scan reads the merge. */
	files: { path: string; state: DriftFileState }[];
}

/** A file a setup writes that applying it left alone, and why. */
export interface ApplyProblem {
	path: string;
	message: string;
}

/**
 * What applying a setup did: opened a pull request, or gave the open one a new commit. Or
 * nothing: the open one already writes these files (`current`), or the repository already holds
 * them (`unchanged`).
 */
export type ApplyOutcome =
	| {
			status: "opened" | "updated" | "current";
			application: SetupApplication;
			problems: ApplyProblem[];
	  }
	| { status: "unchanged"; application: null; problems: ApplyProblem[] };

/**
 * Why a setup was not applied, fit to show the person who asked. The registry returns it rather
 * than throwing: it is an answer, and a thrown error loses its kind on its way out of the
 * Durable Object.
 */
export interface ApplyRefusal {
	status: "refused";
	message: string;
}

export interface Overview {
	projects: number;
	repositories: number;
	agents: number;
	assets: number;
}
