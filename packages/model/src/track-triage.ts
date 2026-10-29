/**
 * Issue triage for Gateweave Track, set up in one click: an agent run by Gateweave that is an
 * agent member of a Track workspace, reaches Track's MCP server with the member's key, and is
 * started by a trigger on each new issue. The instructions it reads are the app's to bundle; the
 * rest of what the setup makes is decided here.
 */
import { z } from "zod";
import { agentDefinitionInput, MAX_WRITTEN_LENGTH, mcpServerUrl } from "./inputs";
import { MODEL_PROVIDERS } from "./vocabulary";

/**
 * The tools of Track's MCP server that triage needs, and no more: the issue it triages comes from
 * whoever opened it, so the agent may not create issues, labels or teams whatever the text asks.
 */
export const TRACK_TRIAGE_TOOLS = [
	"get_workspace",
	"get_issue",
	"search_issues",
	"update_issue",
	"add_comment",
] as const;

/** The secret of the environment set that holds the agent member's key. */
export const TRACK_KEY_VARIABLE = "TRACK_AGENT_KEY";

/** What the setup names what it makes, before a number is added to a name that is taken. */
export const TRACK_TRIAGE_NAMES = {
	agent: "Triage",
	instructions: "Track triage",
	environment: "Track",
	mcpServer: "track",
	trigger: "New issues",
} as const;

/** The trigger's prompt. The event follows it, with the issue's description and who opened it. */
export const TRACK_TRIAGE_PROMPT =
	'A new issue was opened in the Track workspace "{{data.workspace.slug}}": {{data.issue.key}}, "{{data.issue.title}}". Triage it.';

/** The webhook event the trigger is for, which the webhook in Track subscribes to. */
export const TRACK_TRIAGE_EVENT = "issue.created";

/** A Track agent member's key, as Track shows it when it is made. */
const trackAgentKey = z
	.string()
	.trim()
	.regex(/^gwt_[A-Za-z0-9_-]{43}$/, "Paste the whole key, starting with gwt_, as Track shows it");

export const trackTriageInput = z.object({
	/**
	 * Where people open Track, such as https://track.gateweave.com; its MCP server is at `/mcp`.
	 * Any page of Track will do, so the address bar can be pasted as it is.
	 */
	trackUrl: z.string().trim().max(2000).transform(originOf).pipe(mcpServerUrl).transform(originOf),
	agentKey: trackAgentKey,
	name: z.string().trim().min(1).max(200).default(TRACK_TRIAGE_NAMES.agent),
	provider: z.enum(MODEL_PROVIDERS),
	model: agentDefinitionInput.shape.model,
});
export type TrackTriageInput = z.input<typeof trackTriageInput>;

/** What the registry takes to set it up: the input, with the instructions the app bundles. */
export const trackTriagePlan = trackTriageInput.extend({
	instructions: z.string().min(1).max(MAX_WRITTEN_LENGTH),
});
export type TrackTriagePlan = z.input<typeof trackTriagePlan>;

/** Track's MCP server, at the root of where people open Track. */
export function trackMcpUrl(trackUrl: string): string {
	return `${originOf(trackUrl)}/mcp`;
}

/** The scheme and host of a URL, without any user, path or query; anything else as it is. */
function originOf(url: string): string {
	const found = /^(https?:\/\/)(?:[^/?#@]*@)?([^/?#]+)/i.exec(url);
	return found ? `${found[1]}${found[2]}` : url;
}
