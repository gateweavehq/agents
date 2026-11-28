/**
 * The ready-made pull request reviewer, set up in one write: its instructions, the agent that
 * reviews in a sandbox on the chosen repository, and the `pull_request` trigger that starts it.
 * Nothing secret is made: the reviewer uses the workspace's provider key, as every agent does.
 */
import {
	type Agent,
	agentDefinitionInput,
	REVIEW_SETUP_NAMES,
	REVIEW_SETUP_PROMPT,
	REVIEW_SETUP_RUNS_PER_DAY,
	type ReviewSetupPlan,
	type Trigger,
} from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import { assets } from "./db/schema";
import { createAgent } from "./definitions";
import { createLibraryAsset, libraryKey } from "./library";
import type { Db } from "./state";
import { insertTrigger, triggerCapRefusal } from "./triggers";

/** What the setup made: the agent, its trigger, and the instructions asset, for checking it. */
export interface PullRequestReviewSetupMade {
	agent: Agent;
	trigger: Trigger;
	instructionsId: string;
}

export function setUpPullRequestReview(
	db: Db,
	plan: Omit<ReviewSetupPlan, "name"> & {
		name: string;
		createdBy: string;
	},
	now: number,
): PullRequestReviewSetupMade | { refused: string } {
	// Refused before anything is made: a write that returns commits what it made so far.
	const full = triggerCapRefusal(db);
	if (full) return { refused: full };
	const instructions = createLibraryAsset(
		db,
		{
			kind: "instructions",
			name: freeName(db, "instructions", REVIEW_SETUP_NAMES.instructions),
			text: plan.instructions,
		},
		now,
	);
	// An engine that does not fit the model, or a repository the app does not reach, throws here,
	// which undoes the whole write.
	const agent = createAgent(
		db,
		agentDefinitionInput.parse({
			name: plan.name,
			description:
				"Reviews pull requests this workspace's agents open, as a second reader, never the approval.",
			provider: plan.provider,
			model: plan.model,
			instructions: { assetId: instructions, version: 1 },
			environment: null,
			mcpServers: [],
			sandbox: true,
			repositoryId: plan.repositoryId,
			engine: plan.engine,
			memory: false,
		}),
		now,
	);
	const trigger = insertTrigger(
		db,
		{
			id: crypto.randomUUID(),
			name: REVIEW_SETUP_NAMES.trigger,
			prompt: REVIEW_SETUP_PROMPT,
			target: { kind: "agent", agentId: agent.id },
			perDay: REVIEW_SETUP_RUNS_PER_DAY,
			events: null,
			label: null,
			assignee: null,
			assigneeName: null,
			perIssue: false,
			schedule: null,
			pullRequest: true,
			sealed: "",
			secretStart: "",
			createdBy: plan.createdBy,
		},
		now,
	);
	// Its agent was made just now, and the workspace had room: throwing undoes the whole write.
	if ("refused" in trigger) throw new Error(trigger.refused);
	return { agent, trigger, instructionsId: instructions };
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
