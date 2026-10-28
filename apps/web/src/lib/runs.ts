/**
 * Runs of agents run by Gateweave: one per turn of a conversation, with what it used. Owners and
 * admins see every run in the workspace, since they answer for what it spends; members see the
 * runs they started. A run's trace is timing and usage, never the conversation's words, so
 * whoever sees the run sees its trace, while the conversation lasts.
 */
import { RUNS_PER_PAGE, type Run, type RunSpan, runCursor } from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** A run, with the name of the member who started it. */
export interface RunEntry extends Run {
	startedByName: string;
}

/** What a member who left is called on the runs they started. */
const FORMER_MEMBER = "A former member";

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

function named(run: Run, names: Map<string, string>): RunEntry {
	return { ...run, startedByName: names.get(run.startedBy) ?? FORMER_MEMBER };
}

/** The latest runs the caller may see, a page at a time after `before`. */
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
 * One run with its trace, or null when the caller may not see it. The trace is null once its
 * conversation is deleted. `conversation` is set when the caller can open the conversation.
 */
export const getRun = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), runId: z.string().min(1).max(64) }))
	.handler(
		async ({
			data,
		}): Promise<{ run: RunEntry; trace: RunSpan[] | null; conversation: string | null } | null> => {
			const viewer = await viewerOf(data.slug);
			if (!viewer) return null;
			const run = await viewer.registry.getRun(data.runId);
			if (!run || (!viewer.everyone && run.startedBy !== viewer.userId)) return null;
			const { conversationId } = run;
			const [names, trace] = await Promise.all([
				viewer.names(),
				conversationId === null ? null : traceOf(viewer.workspaceId, conversationId, run.id),
			]);
			return {
				run: named(run, names),
				trace,
				conversation: run.startedBy === viewer.userId ? conversationId : null,
			};
		},
	);

async function traceOf(workspaceId: string, conversationId: string, runId: string) {
	const [{ env }, { getAgentByName }, { conversationName }] = await Promise.all([
		import("cloudflare:workers"),
		import("agents"),
		import("@gateweave/agents-runtime"),
	]);
	const conversation = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, conversationId),
	);
	return conversation.runTrace(runId);
}
