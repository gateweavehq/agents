import type {
	DetectedAgent,
	DetectedAsset,
	RepositoryRuntime,
	ScanProblem,
} from "@gateweave/agents-model";

export interface TreeFile {
	/** Git blob id. */
	blob: string;
	/** In bytes. */
	size: number;
	/** The text, when the scanner downloaded it: wanted, not binary, at most MAX_FILE_LENGTH. */
	content?: string;
}

/** A repository at one commit: every file by its path. */
export type RepositoryTree = ReadonlyMap<string, TreeFile>;

export interface Detection {
	agents: DetectedAgent[];
	assets: DetectedAsset[];
	problems: ScanProblem[];
}

/** One coding agent's file formats. Adapters never see each other; `detect` merges them. */
export interface Adapter {
	readonly runtime: RepositoryRuntime;
	/** True for paths whose text this adapter needs. */
	wants(path: string): boolean;
	detect(tree: RepositoryTree): Detection;
}
