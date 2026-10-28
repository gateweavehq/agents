import {
	AGENT_RUNTIMES,
	type Agent,
	type AgentRuntime,
	type Asset,
	type Project,
	type Repository,
	type Setup,
} from "@gateweave/agents-model";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type * as schema from "./db/schema";

export type Db = DrizzleSqliteDODatabase<typeof schema>;

export const toProject = (row: schema.ProjectRow, repositoryIds: string[]): Project => ({
	...row,
	repositoryIds,
});

export const toRepository = (
	{ removedAt: _, ...row }: schema.RepositoryRow,
	projectIds: string[],
	runtimes: Iterable<AgentRuntime>,
	scanPending: boolean,
): Repository => {
	const found = new Set(runtimes);
	return {
		...row,
		projectIds,
		runtimes: AGENT_RUNTIMES.filter((runtime) => found.has(runtime)),
		scanPending,
	};
};

export const toAgent = ({ removedAt: _, ...row }: schema.AgentRow, assetIds: string[]): Agent => ({
	...row,
	assetIds,
});

export const toAsset = ({ removedAt: _, ...row }: schema.AssetRow): Asset => row;

export const toSetup = (row: schema.SetupRow): Setup => row;

/** Groups `[key, value]` pairs into lists by key. */
export function groupBy<K, V>(pairs: Iterable<readonly [K, V]>): Map<K, V[]> {
	const groups = new Map<K, V[]>();
	for (const [key, value] of pairs) {
		const group = groups.get(key);
		if (group) group.push(value);
		else groups.set(key, [value]);
	}
	return groups;
}
