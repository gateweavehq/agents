/**
 * Runs of agents run by Gateweave: one per turn of a conversation, with what it used, and one per
 * turn a team's edge led to, under the run that took the edge. Owners and admins see every run in
 * the workspace, since they answer for what it spends; members see the runs they started. A run's
 * trace is timing and usage, never the conversation's words, so whoever sees the run sees its
 * trace, while the conversation lasts.
 *
 * A trigger's delivery starts a run that no member did, in a conversation nobody opens in Chat, so
 * owners and admins read its words on the run instead.
 */
import {
	RUNS_PER_PAGE,
	type RunSpan,
	runCursor,
	type TotaledRun,
	triggerOf,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** A run, with its total and the name of the member or the trigger that started it. */
export interface RunEntry extends TotaledRun {
	startedByName: string;
}

/** What a member who left is called on the runs they started. */
const FORMER_MEMBER = "A former member";

/** What a trigger is called on its runs once it was deleted. */
const DELETED_TRIGGER = "A deleted trigger";

async function viewerOf(slug: string) {
	const { currentMember } = await import("#/server/access");
	const member = await currentMember(slug);
	if (!member) return null;
	const [{ isAdmin }, { registryFor }, { db }, { memberNames }] = await Promise.all([
		import("#/lib/roles"),
		import("#/server/registry"),
		import("#/server/auth"),
		import("#/server/workspaces"),
	]);
	const { workspaceId, role } = member.membership;
	return {
		userId: member.user.id,
		workspaceId,
		everyone: isAdmin(role),
		registry: registryFor(workspaceId),
		names: () => memberNames(db, workspaceId),
	};
}

function named(run: TotaledRun, names: Map<string, string>): RunEntry {
	if (triggerOf(run.startedBy) !== null) {
		const name = run.triggerName === null ? DELETED_TRIGGER : `${run.triggerName} (trigger)`;
		return { ...run, startedByName: name };
	}
	return { ...run, startedByName: names.get(run.startedBy) ?? FORMER_MEMBER };
}

/**
 * The latest runs people's messages started that the caller may see, a page at a time after
 * `before`, each with the total of the runs it led to.
 */
export const getRuns = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), before: runCursor.optional() }))
	.handler(
		async ({ data }): Promise<{ runs: RunEntry[]; everyone: boolean; more: boolean } | null> => {
			const viewer = await viewerOf(data.slug);
			if (!viewer) return null;
			const [runs, names] = await Promise.all([
				viewer.registry.listRuns({
					startedBy: viewer.everyone ? undefined : viewer.userId,
					before: data.before,
				}),
				viewer.names(),
			]);
			return {
				runs: runs.map((run) => named(run, names)),
				everyone: viewer.everyone,
				more: runs.length === RUNS_PER_PAGE,
			};
		},
	);

/**
 * One run with its trace and the runs it called over its team's edges, or null when the caller may
 * not see it. The trace is null once its conversation is deleted. `conversation` is set when the
 * caller can open the conversation, which a nested run has none of: it ran in a conversation of
 * its own, reached only by its caller's. `transcript` is the conversation of a trigger's run, which
 * nobody opens in Chat, as the JSON of its messages, since what their tools took and gave back can
 * be anything; null for any other run, and once the conversation is deleted.
 */
export const getRun = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), runId: z.string().min(1).max(64) }))
	.handler(
		async ({
			data,
		}): Promise<{
			run: RunEntry;
			trace: RunSpan[] | null;
			nested: RunEntry[];
			conversation: string | null;
			transcript: string | null;
		} | null> => {
			const viewer = await viewerOf(data.slug);
			if (!viewer) return null;
			const run = await viewer.registry.getRun(data.runId);
			if (!run || (!viewer.everyone && run.startedBy !== viewer.userId)) return null;
			const { conversationId } = run;
			const conversation =
				conversationId === null ? null : await conversationOf(viewer.workspaceId, conversationId);
			const triggered = run.triggerId !== null && run.parentRunId === null;
			const [names, trace, nested, transcript] = await Promise.all([
				viewer.names(),
				conversation?.runTrace(run.id) ?? null,
				// Only a team's turns call others.
				run.teamPath === null ? [] : viewer.registry.listNestedRuns(run.id),
				triggered ? (conversation?.transcript() ?? null) : null,
			]);
			return {
				run: named(run, names),
				trace,
				nested: nested.map((each) => named(each, names)),
				conversation:
					run.startedBy === viewer.userId && run.parentRunId === null ? conversationId : null,
				transcript,
			};
		},
	);

async function conversationOf(workspaceId: string, conversationId: string) {
	const [{ env }, { getAgentByName }, { conversationName }] = await Promise.all([
		import("cloudflare:workers"),
		import("agents"),
		import("@gateweave/agents-runtime"),
	]);
	return getAgentByName(env.CONVERSATIONS, conversationName(workspaceId, conversationId));
}
