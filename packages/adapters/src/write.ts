/**
 * The reverse of `detect`: assets from the library in, the files to write into a repository out,
 * in each coding agent's own format. Pure, so the same code can serve a pull request from the
 * Worker and a CLI. The vendor documentation is linked at the top of each writer, next to the
 * reader of the same format.
 *
 * The output is byte-stable: the same assets and runtimes give the same files in the same order
 * whatever order they came in, so a later scan can compare Git blob ids to find drift.
 *
 * What is written: `instructions`, `skill` and `mcp-server` assets. Every other kind has no
 * file that means the same in every repository (`settings` hold an agent's own configuration,
 * `prompt` has a different format per agent, `script` and `env-set` have no agreed place, and
 * `plugin` is a whole folder), so each is reported as a problem and skipped.
 */
import {
	type AssetKind,
	type Metadata,
	REPOSITORY_RUNTIMES,
	type RepositoryRuntime,
} from "@gateweave/agents-model";
import { canonicalJson } from "./redaction";
import { compare } from "./util";
import { writeInstructions } from "./write-instructions";
import { writeMcpServers } from "./write-mcp";
import { Output } from "./write-output";
import { writeSkills } from "./write-skills";

export interface AssetToWrite {
	kind: AssetKind;
	name: string;
	description: string | null;
	/**
	 * As the registry stores them, relative to the asset (see `scannedFile` in the model). The
	 * content is null when the registry did not keep the text, which makes the asset unwritable.
	 */
	files: { path: string; content: string | null }[];
	metadata: Metadata;
}

export interface WrittenFile {
	/** Relative to the repository root. */
	path: string;
	content: string;
}

export interface WriteProblem {
	/** The asset's name. */
	asset: string;
	message: string;
}

export interface WriteResult {
	/** Sorted by path. */
	files: WrittenFile[];
	/** An asset that could not be written, or only for some runtimes, and why. Sorted. */
	problems: WriteProblem[];
}

const UNSUPPORTED: Partial<Record<AssetKind, string>> = {
	settings: "Settings are an agent's own configuration and are not written",
	prompt: "Prompts are not written yet: every agent keeps its slash commands in its own format",
	script: "Scripts have no agreed place in a repository and are not written",
	"env-set": "Environment sets are not written: secrets are kept by reference, never in files",
	plugin: "Plugins are not written yet",
};

export function writeAssets(
	assets: readonly AssetToWrite[],
	runtimes: readonly RepositoryRuntime[],
): WriteResult {
	// Repository order, whatever order the caller used and however often it repeated one.
	const targets = new Set(REPOSITORY_RUNTIMES.filter((runtime) => runtimes.includes(runtime)));
	const output = new Output();
	if (targets.size === 0) return output.result();

	// Equal assets may come in any order; sorting by content makes every choice below repeatable.
	const sorted = assets
		.map((asset) => ({ asset, identity: canonicalJson(asset) }))
		.sort(
			(a, b) =>
				compare(a.asset.kind, b.asset.kind) ||
				compare(a.asset.name, b.asset.name) ||
				compare(a.identity, b.identity),
		)
		.map(({ asset }) => asset);
	const ofKind = (kind: AssetKind) => sorted.filter((asset) => asset.kind === kind);

	writeInstructions(ofKind("instructions"), targets, output);
	writeSkills(ofKind("skill"), targets, output);
	writeMcpServers(ofKind("mcp-server"), targets, output);
	for (const asset of sorted) {
		const message = UNSUPPORTED[asset.kind];
		if (message) output.problem(asset.name, message);
	}
	return output.result();
}
