/**
 * The data part that ties a call over a team's edge to the run it started (AGT-139). The chat
 * reads the run's page from it and links there. Like a reply's own run part it is not transient,
 * so the conversation keeps it and history replays it.
 */
export const EDGE_PART = "data-edge";

/** What an `EDGE_PART` carries. */
export interface EdgePartData {
	/** The tool call whose execution started the run, as Gateweave's own loop names it. */
	toolCallId?: string;
	/**
	 * The edge tool's name and the text it carried. An engine's chat names the call by the engine's
	 * own id, which the tool never sees, so it matches on these instead.
	 */
	toolName?: string;
	text?: string;
	/** The run, in a conversation of the member the edge went to. */
	runId: string;
}
