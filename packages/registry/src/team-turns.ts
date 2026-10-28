/**
 * Turns of a team. A conversation with a team is answered by its lead, and each turn of a team can
 * take the edges its agent has where it stands (`turnEdges`). Taking one is a nested turn of
 * another agent, in a conversation of its own, with a run under the caller's.
 *
 * The registry decides each nested turn against the graphs and the limits as they are when it
 * begins. It keeps where each run's agent stands (`runs.team_path`), so the runtime only says
 * which edge it takes, from which run, and never where that run is in a team.
 */
import { type AgentSnapshot, TEAM_TURN_LIMITS, type TurnVia } from "@gateweave/agents-model";
import { conversationParties } from "./conversations";
import { agentSnapshot } from "./definitions";
import { callingRun, nestedRuns, type RunParent } from "./runs";
import type { Db } from "./state";
import { followEdge, type TeamPosition, teamLead } from "./teams";

/** Why there is no turn, in words fit for whoever asked: a person, or the agent that called. */
export interface TurnRefused {
	refused: string;
}

/** The lead of a conversation's team, at the top of the team. */
export function teamTurnPlan(
	db: Db,
	teamId: string,
): { agent: AgentSnapshot; position: TeamPosition } | TurnRefused {
	const team = teamLead(db, teamId);
	if (!team) return { refused: "This team was deleted, so the conversation cannot go on" };
	const agent = agentSnapshot(db, team.leadAgentId);
	if (!agent) {
		return {
			refused: `The lead of ${team.name} was removed, so the team cannot answer. An owner or admin can choose another lead on the team's page.`,
		};
	}
	return { agent, position: { path: [teamId], agentId: agent.agentId } };
}

/** A nested turn as the registry allows it: who answers, where it stands, and whose it is. */
export interface NestedTurnPlan {
	agent: AgentSnapshot;
	position: TeamPosition;
	parent: RunParent;
	/** The member who started the conversation at the top, whose turn this is part of. */
	startedBy: string;
	/** That conversation, which the nested one goes with. */
	rootConversationId: string;
}

/**
 * The turn an edge leads to. The calling run must still be going, stand where it can take that
 * edge in the graphs as they are now, and be within the limits.
 */
export function nestedTurnPlan(db: Db, via: TurnVia): NestedTurnPlan | TurnRefused {
	const caller = callingRun(db, via.parentRunId);
	if (!caller || caller.status !== "running") {
		return { refused: "The turn that took this edge has ended" };
	}
	if (caller.teamPath === null || caller.conversationId === null) {
		return { refused: "Only a turn of a team can take its edges" };
	}
	if (caller.edge === "ask") return { refused: "An answer to a question takes no edges" };
	const { depth, perTurn, perMessage } = TEAM_TURN_LIMITS;
	if (caller.depth + 1 > depth) {
		return {
			refused: `Turns go at most ${depth} edges deep from a message, so this one cannot go further`,
		};
	}
	const rootRunId = caller.rootRunId ?? caller.id;
	const taken = nestedRuns(db, caller.id, rootRunId);
	if (taken.byTurn >= perTurn) {
		return { refused: `A turn can take at most ${perTurn} edges, and this one has` };
	}
	if (taken.byMessage >= perMessage) {
		return { refused: `One message can lead to at most ${perMessage} turns, and this one has` };
	}
	const position = followEdge(db, { path: caller.teamPath, agentId: caller.agentId }, via);
	if (!position) return { refused: "That edge is no longer in the team" };
	const agent = agentSnapshot(db, position.agentId);
	if (!agent) return { refused: "The agent that edge goes to was removed" };
	const conversation = conversationParties(db, caller.conversationId);
	if (!conversation) return { refused: "The conversation this turn is part of was deleted" };
	return {
		agent,
		position,
		parent: {
			parentRunId: caller.id,
			parentSpanId: via.parentSpanId,
			rootRunId,
			edge: via.kind,
			depth: caller.depth + 1,
		},
		startedBy: caller.startedBy,
		rootConversationId: conversation.rootId ?? caller.conversationId,
	};
}
