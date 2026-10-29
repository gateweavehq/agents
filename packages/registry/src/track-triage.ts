/**
 * Track triage, set up in one write: the instructions, an environment set holding the Track agent
 * member's key, Track's MCP server with that key in its header, the agent that pins all three,
 * and the trigger that starts it on each new issue (see `TRACK_TRIAGE_*` in the model). The
 * caller seals the key and the trigger's secret before the write, so nothing is left half made.
 */
import {
	type Agent,
	agentDefinitionInput,
	TRACK_KEY_VARIABLE,
	TRACK_TRIAGE_EVENT,
	TRACK_TRIAGE_NAMES,
	TRACK_TRIAGE_PROMPT,
	TRACK_TRIAGE_TOOLS,
	type TrackTriagePlan,
	type Trigger,
	trackMcpUrl,
} from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import { assets } from "./db/schema";
import { createAgent } from "./definitions";
import { createEnvSet, storeEnvSecret } from "./environment";
import { createLibraryAsset, libraryKey } from "./library";
import { createMcpServer } from "./mcp-servers";
import type { Db } from "./state";
import { insertTrigger, triggerCapRefusal } from "./triggers";

/** What the setup made: the agent, its trigger, and the MCP server, for checking it. */
export interface TrackTriageMade {
	agent: Agent;
	trigger: Trigger;
	mcpServerId: string;
}

export function setUpTrackTriage(
	db: Db,
	plan: Omit<TrackTriagePlan, "agentKey"> & {
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
): TrackTriageMade | { refused: string } {
	// Refused before anything is made: a write that returns commits what it made so far.
	const full = triggerCapRefusal(db);
	if (full) return { refused: full };
	const instructions = createLibraryAsset(
		db,
		{
			kind: "instructions",
			name: freeName(db, "instructions", TRACK_TRIAGE_NAMES.instructions),
			text: plan.instructions,
		},
		now,
	);
	const environment = createEnvSet(
		db,
		{
			name: freeName(db, "env-set", TRACK_TRIAGE_NAMES.environment),
			variables: {},
			secrets: [TRACK_KEY_VARIABLE],
		},
		now,
		plan.envSetId,
	);
	storeEnvSecret(
		db,
		{ assetId: environment, name: TRACK_KEY_VARIABLE, sealed: plan.sealedKey, setBy: plan.setBy },
		now,
	);
	const mcpServer = createMcpServer(
		db,
		{
			name: freeName(db, "mcp-server", TRACK_TRIAGE_NAMES.mcpServer),
			transport: "http",
			url: trackMcpUrl(plan.trackUrl),
			// The header names the variable, not the key: the runtime fills it in from the env set.
			headers: [{ name: "Authorization", value: `Bearer \${${TRACK_KEY_VARIABLE}}` }],
		},
		now,
	);
	const agent = createAgent(
		db,
		agentDefinitionInput.parse({
			name: plan.name,
			description: `Triages each new issue in Gateweave Track (${new URL(plan.trackUrl).host}).`,
			provider: plan.provider,
			model: plan.model,
			instructions: { assetId: instructions, version: 1 },
			environment: { assetId: environment, version: 1 },
			// The issue is anyone's text: whatever it talks the model into, these are all it can do.
			mcpServers: [{ assetId: mcpServer, version: 1, tools: [...TRACK_TRIAGE_TOOLS] }],
		}),
		now,
	);
	const trigger = insertTrigger(
		db,
		{
			id: plan.triggerId,
			name: TRACK_TRIAGE_NAMES.trigger,
			prompt: TRACK_TRIAGE_PROMPT,
			target: { kind: "agent", agentId: agent.id },
			perDay: 50,
			// Track sends what its webhook was set to send; only a new issue is triage's.
			events: [TRACK_TRIAGE_EVENT],
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

/** `base`, or `base 2`, `base 3` and on, whichever the library has no asset of `kind` named. */
function freeName(db: Db, kind: string, base: string): string {
	for (let n = 1; ; n++) {
		const name = n === 1 ? base : `${base} ${n}`;
		const taken = db
			.select({ id: assets.id })
			.from(assets)
			.where(
				and(
					isNull(assets.repositoryId),
					isNull(assets.removedAt),
					eq(assets.key, libraryKey(kind, name)),
				),
			)
			.get();
		if (!taken) return name;
	}
}
