/**
 * Outside tasks: an MCP client with the `agents:run` scope hands an agent of the workspace a task
 * (`run_agent` on /mcp, AGT-155). The registry admits the task the way it admits a trigger's
 * delivery: the agent must exist and have tasks from outside allowed, the agent
 * must be runnable, and the agent is held to its runs per minute and per day. Each task opens a
 * conversation of its own, started by the person whose token asked, and the runtime begins its
 * run (`beginOutsideTurn`). The run is counted like a trigger's: in the same runs table, under the
 * same sandbox limits.
 *
 * A task's `requestId` names it for its client: a retry with the same id finds the run it began,
 * or is told it is still starting, and starts nothing twice.
 */
import { OUTSIDE_TASK_LIMITS } from "@gateweave/agents-model";
import { and, count, eq, gte, inArray, isNull, min, or } from "drizzle-orm";
import { TITLE_LENGTH } from "./conversations";
import { agentDefinitions, agents, conversations, outsideTasks, runs } from "./db/schema";
import type { Db } from "./state";
import { targetRefusal } from "./triggers";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How long an accepted task may go before its run began, in seconds, before a retry may start it. */
const ACCEPT_RETRY_SECONDS = 60;

export type OutsideAdmission =
	| { status: "start"; conversationId: string }
	| { status: "duplicate"; runId: string | null }
	| { status: "starting"; retryAfter: number }
	| { status: "limited"; retryAfter: number; message: string }
	| { status: "refused"; message: string };

/**
 * Admits one outside task for `agent`, named by its id or its exact name, and opens its
 * conversation. `requestId` is the client's own id for the task, so its retry is not a second
 * task; one is made when the client gives none.
 */
export function admitOutsideTask(
	db: Db,
	input: {
		agent: string;
		requestId: string;
		askedBy: string;
		askedVia: string | null;
		task: string;
	},
	now: number,
): OutsideAdmission {
	const found = outsideTaskAgent(db, input.agent);
	if (found === "ambiguous") {
		return {
			status: "refused",
			message: "More than one agent has that name; use its id",
		};
	}
	if (!found) return { status: "refused", message: "There is no such agent" };
	const agent = found;
	const askedVia = input.askedVia ?? "";
	const earlier = taskOf(db, agent.id, input.askedBy, askedVia, input.requestId);
	if (earlier) {
		if (earlier.status === "started") {
			return { status: "duplicate", runId: earlier.runId };
		}
		if (earlier.status === "accepted") {
			if (earlier.createdAt > now - ACCEPT_RETRY_SECONDS * 1000) {
				return {
					status: "starting",
					retryAfter: secondsUntil(earlier.createdAt + ACCEPT_RETRY_SECONDS * 1000, now),
				};
			}
			// The handoff failed before the run began, so the retry takes the task over, the way a
			// trigger's retry does: the conversation it opened, with no runs, goes with it.
			if (
				earlier.conversationId !== null &&
				earlier.runId === null &&
				!hasRuns(db, earlier.conversationId)
			) {
				db.delete(conversations).where(eq(conversations.id, earlier.conversationId)).run();
			}
			db.delete(outsideTasks)
				.where(
					and(
						eq(outsideTasks.agentId, agent.id),
						eq(outsideTasks.askedBy, input.askedBy),
						eq(outsideTasks.askedVia, askedVia),
						eq(outsideTasks.requestId, input.requestId),
					),
				)
				.run();
		} else {
			return { status: "refused", message: earlier.error ?? "That task could not be started" };
		}
	}
	if (!agent.outsideTasks) {
		return {
			status: "refused",
			message:
				'That agent does not allow tasks from outside. A workspace owner or admin can turn on "Tasks from MCP clients" in the agent\'s settings.',
		};
	}
	const refusal = targetRefusal(db, { kind: "agent", agentId: agent.id });
	if (refusal) return { status: "refused", message: refusal };
	const limited = limitOf(db, agent.id, now);
	if (limited) return { status: "limited", ...limited };

	const conversationId = crypto.randomUUID();
	db.insert(conversations)
		.values({
			id: conversationId,
			agentId: agent.id,
			startedBy: input.askedBy,
			teamId: null,
			rootId: null,
			triggerId: null,
			issue: null,
			title: titleOf(input.task),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(outsideTasks)
		.values({
			agentId: agent.id,
			requestId: input.requestId,
			status: "accepted",
			conversationId,
			runId: null,
			error: null,
			askedBy: input.askedBy,
			askedVia,
			createdAt: now,
		})
		.run();
	return { status: "start", conversationId };
}

/**
 * The task whose run is about to begin in an outside task's conversation: the one it was opened
 * for. Null once that run began or could not.
 */
export function outsideTaskOf(db: Db, conversationId: string) {
	return (
		db
			.select()
			.from(outsideTasks)
			.where(
				and(eq(outsideTasks.conversationId, conversationId), eq(outsideTasks.status, "accepted")),
			)
			.get() ?? null
	);
}

/** Notes that an outside task's run began, or why it could not. */
export function settleOutsideTask(
	db: Db,
	conversationId: string,
	outcome: { runId: string } | { error: string },
): void {
	db.update(outsideTasks)
		.set(
			"runId" in outcome
				? { status: "started", runId: outcome.runId, error: null }
				: { status: "failed", error: outcome.error },
		)
		.where(
			and(eq(outsideTasks.conversationId, conversationId), eq(outsideTasks.status, "accepted")),
		)
		.run();
}

/** One task by its agent and the client's id for it; null when there is none. */
export function taskOf(
	db: Db,
	agentId: string,
	askedBy: string,
	askedVia: string,
	requestId: string,
) {
	return (
		db
			.select()
			.from(outsideTasks)
			.where(
				and(
					eq(outsideTasks.agentId, agentId),
					eq(outsideTasks.askedBy, askedBy),
					eq(outsideTasks.askedVia, askedVia),
					eq(outsideTasks.requestId, requestId),
				),
			)
			.get() ?? null
	);
}

/** Whether the conversation ever had a run: a failed handoff's has none, so its retry replaces it. */
function hasRuns(db: Db, conversationId: string): boolean {
	return (
		db.select({ id: runs.id }).from(runs).where(eq(runs.conversationId, conversationId)).get() !==
		undefined
	);
}

/**
 * The agent, by its id or its exact name, when it runs by Gateweave and can take turns. Null when
 * there is none; "ambiguous" when several share the name.
 */
function outsideTaskAgent(
	db: Db,
	agent: string,
): { id: string; outsideTasks: boolean } | "ambiguous" | null {
	const found = db
		.select({ id: agents.id, outsideTasks: agentDefinitions.outsideTasks })
		.from(agents)
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.where(and(isNull(agents.removedAt), or(eq(agents.id, agent), eq(agents.name, agent))))
		.all();
	if (found.length === 0) return null;
	const byId = found.find((row) => row.id === agent);
	if (byId) return byId;
	if (found.length > 1) return "ambiguous";
	return found[0] ?? null;
}

/**
 * Whether one more task would take the agent over its tasks per minute or per day, and if so when
 * there is room again. Tasks that were taken count, begun or not, as a trigger's deliveries do.
 */
function limitOf(
	db: Db,
	agentId: string,
	now: number,
): { retryAfter: number; message: string } | null {
	const counted = (since: number) =>
		db
			.select({ n: count(), oldest: min(outsideTasks.createdAt) })
			.from(outsideTasks)
			.where(
				and(
					eq(outsideTasks.agentId, agentId),
					inArray(outsideTasks.status, ["accepted", "started"]),
					gte(outsideTasks.createdAt, since),
				),
			)
			.get();
	const minute = counted(now - MINUTE);
	if ((minute?.n ?? 0) >= OUTSIDE_TASK_LIMITS.perMinute) {
		return {
			retryAfter: secondsUntil((minute?.oldest ?? now) + MINUTE, now),
			message: `The agent started ${OUTSIDE_TASK_LIMITS.perMinute} tasks in the last minute`,
		};
	}
	const day = counted(now - DAY);
	if ((day?.n ?? 0) >= OUTSIDE_TASK_LIMITS.perDay) {
		return {
			retryAfter: secondsUntil((day?.oldest ?? now) + DAY, now),
			message: `The agent started its ${OUTSIDE_TASK_LIMITS.perDay} tasks for the day`,
		};
	}
	return null;
}

function secondsUntil(at: number, now: number): number {
	return Math.max(1, Math.ceil((at - now) / 1000));
}

function titleOf(task: string): string {
	const line = task.split("\n", 1)[0] ?? "";
	return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}
