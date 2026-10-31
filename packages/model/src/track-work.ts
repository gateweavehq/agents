/**
 * Work on Gateweave Track issues, set up in one click: an agent run by Gateweave that is an agent
 * member of a Track workspace and works in a sandbox on one of the workspace's repositories. A
 * trigger starts it whenever an issue is assigned to that member; it reaches Track's MCP server
 * with the member's key, as triage does (`./track-triage.ts`), and its work becomes a pull
 * request. The instructions it reads are the app's to bundle; the rest of what the setup makes is
 * decided here.
 */
import { z } from "zod";
import { agentDefinitionInput, MAX_WRITTEN_LENGTH } from "./inputs";
import { trackAgentKey, trackUrlInput } from "./track-triage";
import { triggerAssignee } from "./triggers";
import { AGENT_ENGINES, MODEL_PROVIDERS } from "./vocabulary";

/**
 * The tools of Track's MCP server that the work needs: reading the issue and the workspace,
 * commenting, and moving the issue along. Anyone in the Track workspace can write an issue, so
 * the agent may not create issues, labels or teams, whatever the issue asks.
 */
export const TRACK_WORK_TOOLS = [
	"get_workspace",
	"get_issue",
	"search_issues",
	"update_issue",
	"add_comment",
] as const;

/** What the setup names what it makes, before a number is added to a name that is taken. */
export const TRACK_WORK_NAMES = {
	agent: "Coder",
	instructions: "Track issue work",
	environment: "Track",
	mcpServer: "track",
	trigger: "Assigned issues",
} as const;

/** The trigger's prompt. The event follows it, with the issue's description and who assigned it. */
export const TRACK_WORK_PROMPT =
	'The issue {{data.issue.key}}, "{{data.issue.title}}", in the Track workspace "{{data.workspace.slug}}" is assigned to you. Work on it.';

/**
 * The webhook events the trigger is for: an issue made with the agent as its assignee, or one
 * assigned to it later. The trigger's assignee filter skips the rest.
 */
export const TRACK_WORK_EVENTS = ["issue.created", "issue.updated"] as const;

/** Runs the trigger may start in a day: each can hold a sandbox for up to an hour. */
export const TRACK_WORK_RUNS_PER_DAY = 20;

export const trackWorkInput = z.object({
	trackUrl: trackUrlInput,
	agentKey: trackAgentKey,
	name: z.string().trim().min(1).max(200).default(TRACK_WORK_NAMES.agent),
	provider: z.enum(MODEL_PROVIDERS),
	model: agentDefinitionInput.shape.model,
	/** What takes its turns; the registry holds it to the engine's rules, as for any agent. */
	engine: z.enum(AGENT_ENGINES),
	/** The repository it works in, which the workspace's GitHub App reaches. */
	repositoryId: z.string().min(1, "Choose the repository it works in").max(64),
});
export type TrackWorkInput = z.input<typeof trackWorkInput>;

/**
 * What the registry takes to set it up: the input, with the instructions the app bundles and the
 * agent member's id in Track, which the app read with the key.
 */
export const trackWorkPlan = trackWorkInput.extend({
	instructions: z.string().min(1).max(MAX_WRITTEN_LENGTH),
	memberId: triggerAssignee.unwrap(),
});
export type TrackWorkPlan = z.input<typeof trackWorkPlan>;
