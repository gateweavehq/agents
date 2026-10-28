/**
 * Runs: each turn of a conversation with an agent run by Gateweave, summed up. The runtime opens
 * one when a turn is about to call the model and closes it when the turn ends, with what it used;
 * the step-by-step trace stays in the conversation's Durable Object. Runs outlive their
 * conversations, so a workspace's usage stays counted after a conversation is deleted.
 */
import {
	type AgentSnapshot,
	RUNS_PER_PAGE,
	type Run,
	type RunCursor,
	type RunFinish,
	type RunTotal,
	type RunUsage,
	type TeamEdgeKind,
	type TotaledRun,
} from "@gateweave/agents-model";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
	sum,
} from "drizzle-orm";
import { agents, runs } from "./db/schema";
import type { Db } from "./state";

/** A run still going after this long was cut short and will not report back. */
export const RUN_TIMEOUT = 60 * 60 * 1000;

/** Where a nested run sits: the run that called it over an edge, and the run at the top. */
export interface RunParent {
	parentRunId: string;
	parentSpanId: string;
	rootRunId: string;
	edge: TeamEdgeKind;
	depth: number;
}

export function beginRun(
	db: Db,
	{
		agent,
		conversationId,
		startedBy,
		teamPath = null,
		parent = null,
	}: {
		agent: AgentSnapshot;
		conversationId: string;
		startedBy: string;
		teamPath?: string[] | null;
		parent?: RunParent | null;
	},
	now: number,
): string {
	const id = crypto.randomUUID();
	db.insert(runs)
		.values({
			id,
			agentId: agent.agentId,
			conversationId,
			startedBy,
			provider: agent.provider,
			model: agent.model,
			status: "running",
			startedAt: now,
			teamPath,
			...parent,
		})
		.run();
	return id;
}

/** A run that may call others over a team's edges, as a nested turn needs it; null if none. */
export function callingRun(db: Db, id: string) {
	return (
		db
			.select({
				id: runs.id,
				agentId: runs.agentId,
				conversationId: runs.conversationId,
				startedBy: runs.startedBy,
				status: runs.status,
				rootRunId: runs.rootRunId,
				edge: runs.edge,
				depth: runs.depth,
				teamPath: runs.teamPath,
			})
			.from(runs)
			.where(eq(runs.id, id))
			.get() ?? null
	);
}

/** How many runs one run has called, and how many the run at the top has led to in all. */
export function nestedRuns(
	db: Db,
	parentRunId: string,
	rootRunId: string,
): { byTurn: number; byMessage: number } {
	const byTurn = db
		.select({ n: count() })
		.from(runs)
		.where(eq(runs.parentRunId, parentRunId))
		.get();
	const byMessage = db.select({ n: count() }).from(runs).where(eq(runs.rootRunId, rootRunId)).get();
	return { byTurn: byTurn?.n ?? 0, byMessage: byMessage?.n ?? 0 };
}

/**
 * Closes a run that is still going, or one `expireRuns` closed without hearing from it. A run
 * hears once: a later report changes nothing.
 */
export function finishRun(db: Db, id: string, finish: Required<RunFinish>): boolean {
	const closed = db
		.update(runs)
		.set(finish)
		.where(
			and(
				eq(runs.id, id),
				or(eq(runs.status, "running"), and(eq(runs.status, "interrupted"), isNull(runs.endedAt))),
			),
		)
		.returning({ id: runs.id })
		.get();
	return closed !== undefined;
}

/**
 * The runs people's messages started, the latest first, a page at a time, each with the total of
 * the runs nested under it: everyone's, or one member's with `startedBy`. `before` is the last run
 * of the page before.
 */
export function listRuns(
	db: Db,
	{ startedBy, before }: { startedBy?: string; before?: RunCursor },
): TotaledRun[] {
	const page = selectRuns(db)
		.where(
			and(
				isNull(runs.parentRunId),
				startedBy === undefined ? undefined : eq(runs.startedBy, startedBy),
				before === undefined
					? undefined
					: or(
							lt(runs.startedAt, before.startedAt),
							and(eq(runs.startedAt, before.startedAt), lt(runs.id, before.id)),
						),
			),
		)
		.orderBy(desc(runs.startedAt), desc(runs.id))
		.limit(RUNS_PER_PAGE)
		.all()
		.map(toRun);
	return withTotals(db, page);
}

export function getRun(db: Db, id: string): TotaledRun | null {
	const row = selectRuns(db).where(eq(runs.id, id)).get();
	return row ? (withTotals(db, [toRun(row)])[0] ?? null) : null;
}

/** The runs one run called over its team's edges, in the order it called them. */
export function listNestedRuns(db: Db, parentRunId: string): TotaledRun[] {
	const nested = selectRuns(db)
		.where(eq(runs.parentRunId, parentRunId))
		.orderBy(asc(runs.startedAt), asc(runs.id))
		.all()
		.map(toRun);
	return withTotals(db, nested);
}

/**
 * The runs of a conversation still going: the turn answering the person's message, and those it
 * led to over the team's edges, which may go on after it, as a report does.
 */
export function activeRuns(db: Db, conversationId: string): Run[] {
	const turns = db
		.select({ id: runs.id })
		.from(runs)
		.where(and(eq(runs.conversationId, conversationId), isNull(runs.parentRunId)));
	return selectRuns(db)
		.where(
			and(
				eq(runs.status, "running"),
				or(eq(runs.conversationId, conversationId), inArray(runs.rootRunId, turns)),
			),
		)
		.orderBy(asc(runs.startedAt), asc(runs.id))
		.all()
		.map(toRun);
}

/**
 * Each run with what it and the runs nested under it used. The runs one message led to are few
 * (`TEAM_TURN_LIMITS.perMessage`), so they are read whole and added up here.
 */
function withTotals(db: Db, list: Run[]): TotaledRun[] {
	if (list.length === 0) return [];
	const tops = [...new Set(list.map((run) => run.rootRunId ?? run.id))];
	const family = db
		.select({
			id: runs.id,
			parentRunId: runs.parentRunId,
			status: runs.status,
			inputTokens: runs.inputTokens,
			outputTokens: runs.outputTokens,
			cost: runs.cost,
		})
		.from(runs)
		.where(inArray(runs.rootRunId, tops))
		.all();
	const called = new Map<string, typeof family>();
	for (const run of family) {
		if (run.parentRunId === null) continue;
		called.set(run.parentRunId, [...(called.get(run.parentRunId) ?? []), run]);
	}
	return list.map((run) => {
		const total: RunTotal = {
			runs: 0,
			running: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			unpriced: 0,
		};
		const add = (one: Pick<Run, "id" | "status" | "inputTokens" | "outputTokens" | "cost">) => {
			total.runs++;
			total.inputTokens += one.inputTokens;
			total.outputTokens += one.outputTokens;
			// A run still going has no cost yet, which says nothing of its prices.
			if (one.status === "running") total.running++;
			else if (one.cost === null) total.unpriced++;
			if (one.cost !== null) total.cost += one.cost;
			for (const next of called.get(one.id) ?? []) add(next);
		};
		add(run);
		return { ...run, total };
	});
}

/** What the workspace's runs used since `since`. */
export function runUsage(db: Db, since: number): RunUsage {
	const row = db
		.select({
			runs: count(),
			inputTokens: sum(runs.inputTokens).mapWith(Number),
			outputTokens: sum(runs.outputTokens).mapWith(Number),
			cost: sum(runs.cost).mapWith(Number),
			unpriced: sql<number>`count(*) - count(${runs.cost})`.mapWith(Number),
		})
		.from(runs)
		.where(gte(runs.startedAt, since))
		.get();
	return {
		runs: row?.runs ?? 0,
		inputTokens: row?.inputTokens ?? 0,
		outputTokens: row?.outputTokens ?? 0,
		cost: row?.cost ?? 0,
		unpriced: row?.unpriced ?? 0,
	};
}

/** The runs of a conversation that is being deleted lose their link to it, and nothing else. */
export function detachRuns(db: Db, conversationId: string): void {
	db.update(runs)
		.set({ conversationId: null })
		.where(and(isNotNull(runs.conversationId), eq(runs.conversationId, conversationId)))
		.run();
}

/**
 * Marks runs that have gone on for longer than any turn does as interrupted. The runtime closes
 * the runs a restart cut short when its conversation wakes again, but a conversation nobody opens
 * again never wakes. If one does, its report still fills in what the run used (`finishRun`).
 */
export function expireRuns(db: Db, now: number): void {
	db.update(runs)
		.set({ status: "interrupted" })
		.where(and(eq(runs.status, "running"), lt(runs.startedAt, now - RUN_TIMEOUT)))
		.run();
}

function selectRuns(db: Db) {
	return db
		.select({ run: runs, agentName: agents.name })
		.from(runs)
		.innerJoin(agents, eq(agents.id, runs.agentId))
		.$dynamic();
}

function toRun({ run, agentName }: { run: typeof runs.$inferSelect; agentName: string }): Run {
	return { ...run, agentName };
}
