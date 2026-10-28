/** What the registry returns. Times are milliseconds since the epoch. */
import type { Metadata, ScanProblem } from "./inputs";
import type {
	AgentRuntime,
	ApplicationState,
	AssetKind,
	DriftFileState,
	DriftState,
	ModelProvider,
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
export interface PinnedAsset {
	asset: Asset;
	version: number;
	/** True when it has left the library. The pinned version still exists and is still used. */
	removed: boolean;
}

export type SetupAsset = PinnedAsset;

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

/**
 * A model provider's key as the app shows it. The key itself never leaves the registry: `hint`
 * is its last four characters, enough to tell two keys apart.
 */
export interface ProviderKey {
	provider: ModelProvider;
	hint: string;
	/** Who added it, by name, as the app knew them then. Replacing a key adds a new one. */
	addedBy: string;
	addedAt: number;
	/** The last time the key was tried against the provider, if it was. */
	check: ProviderCheck | null;
}

/** Trying a key: listing the provider's models, which proves the key works and costs nothing. */
export interface ProviderCheck {
	ok: boolean;
	/** Why it failed, in the app's words; never the provider's, which can echo part of the key. */
	message: string | null;
	/** How many models the key can use, when it worked. */
	models: number | null;
	checkedAt: number;
}

/** A model a provider offers to a key. */
export interface ProviderModel {
	/** What the provider's API calls it, such as `claude-opus-5-5`. */
	id: string;
	/** What people call it, such as "Claude Opus 5.5". */
	name: string;
}

/**
 * Why a key was not saved or tried, fit to show the person who asked: the server has no
 * `SECRETS_KEY`, or the workspace has no key for that provider. Returned rather than thrown, as
 * `ApplyRefusal` is.
 */
export interface ProviderRefusal {
	status: "refused";
	message: string;
}

/** How an agent run by Gateweave works: the model it calls and what it always reads. */
export interface AgentDefinition {
	provider: ModelProvider;
	/** The provider's id for the model. */
	model: string;
	/** Null when it has none. */
	instructions: PinnedAsset | null;
	/** The environment set it runs with; null when it has none. */
	environment: PinnedAsset | null;
}

/** An agent with where it is configured and what it reads. */
export interface AgentDetail {
	agent: Agent;
	/** Null for an agent defined in the app. */
	repository: { id: string; owner: string; name: string } | null;
	/** The live assets it reads, for an agent found in a repository. */
	assets: Asset[];
	/** How it is set up, for an agent run by Gateweave. */
	definition: AgentDefinition | null;
	/** The files of its instructions at the pinned version. */
	instructions: AssetFile[];
}

/**
 * What the runtime reads at the start of a turn, in one read, so a turn never mixes two versions
 * of an agent.
 */
export interface AgentSnapshot {
	agentId: string;
	name: string;
	provider: ModelProvider;
	model: string;
	/** The text of its instructions, files in path order; null when it has none. */
	instructions: string | null;
	/** When the definition last changed. */
	updatedAt: number;
}

/** A secret an environment set declares. Its value is never part of this. */
export interface EnvSecret {
	name: string;
	/** Whether a value is stored for it. */
	state: "set" | "missing";
	/** Who stored the value, and when; null while it is missing. */
	setBy: string | null;
	setAt: number | null;
}

/** A value stored for a name the set's current version no longer declares as a secret. */
export interface EnvOrphan {
	name: string;
	setBy: string;
	setAt: number;
}

/** An environment set as the Environment page shows it: names, never secret values. */
export interface EnvSetEntry {
	/** `asset.version` is the current version. */
	asset: Asset;
	variables: Record<string, string>;
	secrets: EnvSecret[];
	orphans: EnvOrphan[];
	/** The live agents that run with it, and the version each has pinned. */
	agents: { id: string; name: string; version: number }[];
}

/** Why a secret's value was not stored or removed, fit to show the person who asked. */
export interface EnvRefusal {
	status: "refused";
	message: string;
}

/**
 * The environment an agent runs with: the pinned version's variables and the opened secrets, and
 * the names of secrets that have no value yet. For the runtime only; no page or server function
 * may return it.
 */
export interface ResolvedEnvironment {
	values: Record<string, string>;
	missing: string[];
}
