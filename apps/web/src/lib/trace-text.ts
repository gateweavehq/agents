import type { EdgeSpan, Run, TeamEdgeKind } from "@gateweave/agents-model";

/** A run's trace in words, for the run's page. */

/** What a call over an edge did, before the name of the member it went to. */
const EDGE_CALLS: Record<TeamEdgeKind, string> = {
	delegate: "Delegate to",
	ask: "Ask",
	report: "Report to",
};

/** What stands for a member whose name the page cannot tell: "Delegate to an agent that is gone". */
export const MEMBER_GONE = "an agent that is gone";

/** An id as the registry makes them. No person reads one, so a title never shows one. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The title of a call over one of a team's edges: what it did, and the name of the member it went
 * to, or null when the page cannot tell it. The runtime records the member's name with the call.
 * A trace that holds an id instead, as the demo's sample once did, is named by the run the call
 * started, which is among `nested` and knows who answered; with no such run, as when the registry
 * refused the call or the run is gone, there is no name to show, and an id is never one.
 */
export function edgeCallTitle(
	span: Pick<EdgeSpan, "edge" | "to" | "childRunId">,
	nested: readonly Pick<Run, "id" | "agentName">[],
): { call: string; member: string | null } {
	const call = EDGE_CALLS[span.edge];
	if (!ID.test(span.to)) return { call, member: span.to };
	const started = nested.find((run) => run.id === span.childRunId);
	return { call, member: started?.agentName ?? null };
}
