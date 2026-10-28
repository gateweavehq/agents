import {
	type DetectedAgent,
	type DetectedAsset,
	detectedAgent,
	detectedAsset,
	REPOSITORY_RUNTIMES,
	repositoryPath,
	type ScanProblem,
} from "@gateweave/agents-model";
import { addProblem } from "./assets";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { cursor } from "./cursor";
import { geminiCli } from "./gemini-cli";
import type { Adapter, Detection, RepositoryTree, TreeFile } from "./types";
import { compare, isEnvFile } from "./util";

const ADAPTERS: readonly Adapter[] = [claudeCode, codex, geminiCli, cursor];

/** What one scan may hold, as `scanResult` in the model allows. */
const MAX_AGENTS = 500;
const MAX_ASSETS = 5000;
const MAX_PROBLEMS = 100;

/** Vendored copies of other projects are not this repository's agents. */
function isVendored(path: string): boolean {
	return path.startsWith("node_modules/") || path.includes("/node_modules/");
}

function wantedByAny(path: string): boolean {
	return ADAPTERS.some((adapter) => adapter.wants(path));
}

/** True for paths whose text any adapter needs. The scanner downloads only these. */
export function wantsFile(path: string): boolean {
	return !isVendored(path) && !isEnvFile(path) && wantedByAny(path);
}

/**
 * Every agent and asset the adapters find in the tree, as a scan the registry accepts: a
 * repository that defeats an adapter loses that piece, with a problem, never the whole scan.
 */
export function detect(tree: RepositoryTree): Detection {
	const problems: ScanProblem[] = [];
	const visible = storableTree(tree, problems);
	const assets = new Map<string, DetectedAsset>();
	const agents: DetectedAgent[] = [];

	for (const adapter of ADAPTERS) {
		const result = adapter.detect(visible);
		for (const asset of result.assets) {
			const known = assets.get(asset.key);
			if (!known) assets.set(asset.key, asset);
			else if (JSON.stringify(known) !== JSON.stringify(asset)) {
				// Adapters share the code that reads a shared file, so this means a bug, not a repository.
				addProblem(problems, asset.path, `Adapters read ${asset.key} differently`);
			}
		}
		agents.push(...result.agents);
		problems.push(...result.problems);
	}

	const keptAssets = valid(
		[...assets.values()].sort((a, b) => compare(a.key, b.key)),
		(asset) => detectedAsset.safeParse(asset).success,
		MAX_ASSETS,
		(asset) => asset.path,
		problems,
	);
	// An agent links only to assets this scan keeps, which also keeps its links within limits.
	const keys = new Set(keptAssets.map((asset) => asset.key));
	const keptAgents = valid(
		agents
			.map((agent) => ({ ...agent, assets: agent.assets.filter((key) => keys.has(key)) }))
			.sort(byRuntimeThenKey),
		(agent) => detectedAgent.safeParse(agent).success,
		MAX_AGENTS,
		(agent) => agent.path,
		problems,
	);

	return { agents: keptAgents, assets: keptAssets, problems: cleanProblems(problems) };
}

/**
 * The tree without vendored code and without paths the registry cannot store. Git allows a few,
 * such as a backslash in a file name; one in an agent's folder is reported and left out.
 */
function storableTree(tree: RepositoryTree, problems: ScanProblem[]): RepositoryTree {
	const kept = new Map<string, TreeFile>();
	for (const [path, file] of tree) {
		if (isVendored(path)) continue;
		if (repositoryPath.safeParse(path).success) kept.set(path, file);
		else if (wantedByAny(path)) addProblem(problems, path, "Left out: the path cannot be stored");
	}
	return kept;
}

/** The items that pass `check`, up to `max`. Each one left out is reported at its path. */
function valid<T>(
	items: readonly T[],
	check: (item: T) => boolean,
	max: number,
	pathOf: (item: T) => string | null,
	problems: ScanProblem[],
): T[] {
	const kept: T[] = [];
	for (const item of items) {
		const path = pathOf(item);
		if (!check(item)) {
			if (path !== null)
				addProblem(problems, path, "Left out: it does not fit the registry's limits");
		} else if (kept.length < max) {
			kept.push(item);
		} else {
			if (path !== null)
				addProblem(problems, path, `Left out: a scan keeps at most ${max} of these`);
		}
	}
	return kept;
}

/**
 * Problems once each, in order, at most as many as a scan holds. A problem about a path the
 * registry cannot store moves up to the longest part of it that it can.
 */
function cleanProblems(problems: readonly ScanProblem[]): ScanProblem[] {
	const unique = new Map<string, ScanProblem>();
	for (const problem of problems) {
		const path = storablePrefix(problem.path);
		if (path === null) continue;
		unique.set(`${path}\0${problem.message}`, { path, message: problem.message });
	}
	return [...unique.values()]
		.sort((a, b) => compare(a.path, b.path) || compare(a.message, b.message))
		.slice(0, MAX_PROBLEMS);
}

function storablePrefix(path: string): string | null {
	const segments = path.split("/");
	for (let length = segments.length; length > 0; length--) {
		const prefix = segments.slice(0, length).join("/");
		if (repositoryPath.safeParse(prefix).success) return prefix;
	}
	return null;
}

function byRuntimeThenKey(a: DetectedAgent, b: DetectedAgent): number {
	const order = REPOSITORY_RUNTIMES.indexOf(a.runtime) - REPOSITORY_RUNTIMES.indexOf(b.runtime);
	// `main` first: it is the coding agent itself.
	if (order !== 0) return order;
	if (a.key === "main" || b.key === "main") return a.key === "main" ? -1 : 1;
	return compare(a.key, b.key);
}
