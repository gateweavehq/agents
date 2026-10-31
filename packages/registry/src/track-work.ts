/**
 * Work on Gateweave Track issues, set up in one write: the instructions, an environment set
 * holding the Track agent member's key, Track's MCP server with that key in its header, the agent
 * that pins all three and works in a sandbox on the chosen repository, and the trigger that starts
 * it whenever an issue is assigned to the member (see `TRACK_WORK_*` in the model). The caller
 * seals the key and the trigger's secret before the write, so nothing is left half made.
 */
import {
	agentDefinitionInput,
	TRACK_WORK_EVENTS,
	TRACK_WORK_NAMES,
	TRACK_WORK_PROMPT,
	TRACK_WORK_RUNS_PER_DAY,
	TRACK_WORK_TOOLS,
	type TrackWorkPlan,
} from "@gateweave/agents-model";
import { createAgent } from "./definitions";
import type { Db } from "./state";
import { makeTrackAccess, type TrackTriageMade } from "./track-triage";
import { insertTrigger, triggerCapRefusal } from "./triggers";

/** What the setup made: the agent, its trigger, and the MCP server, for checking it. */
export type TrackWorkMade = TrackTriageMade;

export function setUpTrackWork(
	db: Db,
	plan: Omit<TrackWorkPlan, "agentKey"> & {
		name: string;
		envSetId: string;
		sealedKey: string;
		triggerId: string;
		sealedSecret: string;
		secretStart: string;
		createdBy: string;
		setBy: string;
	},
	now: number,
): TrackWorkMade | { refused: string } {
	// Refused before anything is made: a write that returns commits what it made so far.
	const full = triggerCapRefusal(db);
	if (full) return { refused: full };
	const { instructions, environment, mcpServer } = makeTrackAccess(
		db,
		{ ...plan, names: TRACK_WORK_NAMES },
		now,
	);
	// An engine that does not fit the model, or a repository the app does not reach, throws here,
	// which undoes the whole write.
	const agent = createAgent(
		db,
		agentDefinitionInput.parse({
			name: plan.name,
			description: `Works on the issues assigned to it in Gateweave Track (${new URL(plan.trackUrl).host}), and opens a pull request of its work.`,
			provider: plan.provider,
			model: plan.model,
			instructions: { assetId: instructions, version: 1 },
			environment: { assetId: environment, version: 1 },
			// The issue is anyone's text: whatever it talks the model into, these are all it can do
			// in Track.
			mcpServers: [{ assetId: mcpServer, version: 1, tools: [...TRACK_WORK_TOOLS] }],
			sandbox: true,
			repositoryId: plan.repositoryId,
			engine: plan.engine,
		}),
		now,
	);
	const trigger = insertTrigger(
		db,
		{
			id: plan.triggerId,
			name: TRACK_WORK_NAMES.trigger,
			prompt: TRACK_WORK_PROMPT,
			target: { kind: "agent", agentId: agent.id },
			perDay: TRACK_WORK_RUNS_PER_DAY,
			events: [...TRACK_WORK_EVENTS],
			label: null,
			// Only an issue just assigned to the agent member starts a run.
			assignee: plan.memberId,
			schedule: null,
			sealed: plan.sealedSecret,
			secretStart: plan.secretStart,
			createdBy: plan.createdBy,
		},
		now,
	);
	// Its agent was made just now, and the workspace had room: throwing undoes the whole write.
	if ("refused" in trigger) throw new Error(trigger.refused);
	return { agent, trigger, mcpServerId: mcpServer };
}
