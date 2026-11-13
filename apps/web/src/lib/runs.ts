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
		workspace: member.membership,
		everyone: isAdmin(role),
		registry: registryFor(member.membership),
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
			replayable: boolean;
			replays: RunEntry[];
		} | null> => {
			const viewer = await viewerOf(data.slug);
			if (!viewer) return null;
			const run = await viewer.registry.getRun(data.runId);
			if (!run || (!viewer.everyone && run.startedBy !== viewer.userId)) return null;
			const { conversationId } = run;
			const conversation =
				conversationId === null ? null : await conversationOf(viewer.workspace, conversationId);
			const triggered = run.triggerId !== null && run.parentRunId === null;
			const [names, trace, nested, transcript, replays] = await Promise.all([
				viewer.names(),
				conversation?.runTrace(run.id) ?? null,
				// Only a team's turns call others.
				run.teamPath === null ? [] : viewer.registry.listNestedRuns(run.id),
				triggered ? (conversation?.transcript() ?? null) : null,
				viewer.registry.listReplays(run.id),
			]);
			return {
				run: named(run, names),
				trace,
				nested: nested.map((each) => named(each, names)),
				conversation:
					run.startedBy === viewer.userId && run.parentRunId === null ? conversationId : null,
				transcript,
				// The registry decides again; this only says whether to offer it.
				replayable:
					conversation !== null &&
					run.parentRunId === null &&
					run.status !== "running" &&
					(run.startedBy === viewer.userId || (viewer.everyone && triggered)),
				replays: replays
					.filter((each) => viewer.everyone || each.startedBy === viewer.userId)
					.map((each) => named(each, names)),
			};
		},
	);

/**
 * Replays a run from its model request `step` (AGT-73): a new conversation of the caller's gets
 * the run's conversation up to that request, and the agent, as it is now, answers from there.
 * The registry decides who may: whoever started the run, and owners and admins a trigger's run.
 * Returns the new run, whose page links back to this one.
 */
export const replayRun = createServerFn({ method: "POST" })
	.validator(
		z.object({
			slug: z.string().min(1),
			runId: z.string().min(1).max(64),
			step: z.number().int().nonnegative().max(1000),
		}),
	)
	.handler(async ({ data }): Promise<{ runId: string }> => {
		const viewer = await viewerOf(data.slug);
		if (!viewer) throw new Error("Workspace not found");
		const run = await viewer.registry.getRun(data.runId);
		if (!run || (!viewer.everyone && run.startedBy !== viewer.userId)) {
			throw new Error("Run not found");
		}
		if (run.conversationId === null) {
			throw new Error("Its conversation was deleted, so there is nothing to replay");
		}
		// Read the words first: a run from before replays kept its message makes no conversation.
		const original = await conversationOf(viewer.workspace, run.conversationId);
		const history = await original.replaySource(run.id, data.step);
		if (history === null) {
			throw new Error(
				"This run began before runs could be replayed, so its messages are not known",
			);
		}
		const started = await viewer.registry.replayRun(
			run.id,
			data.step,
			viewer.userId,
			viewer.everyone,
		);
		if ("status" in started) throw new Error(started.message);
		const replay = await conversationOf(viewer.workspace, started.conversationId);
		const outcome = await replay.replayTurn(history);
		if (outcome.runId === null)
			throw new Error("error" in outcome ? outcome.error : "It did not start");
		return { runId: outcome.runId };
	});

async function conversationOf(
	workspace: { workspaceId: string; jurisdiction: string | null },
	conversationId: string,
) {
	const { conversationFor } = await import("#/server/registry");
	return conversationFor(workspace, conversationId);
}
