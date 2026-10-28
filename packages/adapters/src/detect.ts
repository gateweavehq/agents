import {
	type DetectedAgent,
	type DetectedAsset,
	REPOSITORY_RUNTIMES,
	type ScanProblem,
} from "@gateweave/agents-model";
import { addProblem } from "./assets";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { cursor } from "./cursor";
import { geminiCli } from "./gemini-cli";
import type { Adapter, Detection, RepositoryTree } from "./types";
import { compare, isEnvFile } from "./util";

const ADAPTERS: readonly Adapter[] = [claudeCode, codex, geminiCli, cursor];

/** Vendored copies of other projects are not this repository's agents. */
function isVendored(path: string): boolean {
	return path.startsWith("node_modules/") || path.includes("/node_modules/");
}

/** True for paths whose text any adapter needs. The scanner downloads only these. */
export function wantsFile(path: string): boolean {
	return !isVendored(path) && !isEnvFile(path) && ADAPTERS.some((adapter) => adapter.wants(path));
}

/** Every agent and asset the adapters find in the tree. */
export function detect(tree: RepositoryTree): Detection {
	const visible: RepositoryTree = new Map([...tree].filter(([path]) => !isVendored(path)));
	const assets = new Map<string, DetectedAsset>();
	const agents: DetectedAgent[] = [];
	const problems = new Map<string, ScanProblem>();
	const disagreements: ScanProblem[] = [];

	for (const adapter of ADAPTERS) {
		const result = adapter.detect(visible);
		for (const asset of result.assets) {
			const known = assets.get(asset.key);
			if (!known) assets.set(asset.key, asset);
			else if (JSON.stringify(known) !== JSON.stringify(asset)) {
				// Adapters share the code that reads a shared file, so this means a bug, not a repository.
				addProblem(disagreements, asset.path, `Adapters read ${asset.key} differently`);
			}
		}
		agents.push(...result.agents);
		for (const problem of result.problems) {
			problems.set(`${problem.path}\0${problem.message}`, problem);
		}
	}
	for (const problem of disagreements) problems.set(`${problem.path}\0${problem.message}`, problem);

	return {
		agents: agents.sort(byRuntimeThenKey),
		assets: [...assets.values()].sort((a, b) => compare(a.key, b.key)),
		problems: [...problems.values()]
			.sort((a, b) => compare(a.path, b.path) || compare(a.message, b.message))
			.slice(0, 100),
	};
}

function byRuntimeThenKey(a: DetectedAgent, b: DetectedAgent): number {
	const order = REPOSITORY_RUNTIMES.indexOf(a.runtime) - REPOSITORY_RUNTIMES.indexOf(b.runtime);
	// `main` first: it is the coding agent itself.
	if (order !== 0) return order;
	if (a.key === "main" || b.key === "main") return a.key === "main" ? -1 : 1;
	return compare(a.key, b.key);
}
