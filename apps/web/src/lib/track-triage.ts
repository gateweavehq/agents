/**
 * Issue triage for Gateweave Track in one click, for owners and admins: the registry makes the
 * agent, its instructions, an environment set with the Track agent member's key, Track's MCP
 * server and a trigger for new issues (see `TRACK_TRIAGE_*` in the model). The key is tried on
 * Track's MCP server first, so a mistyped key or URL is said at once rather than on the first
 * issue, and nothing is made with it.
 */
import {
	TRACK_TRIAGE_NAMES,
	TRACK_TRIAGE_TOOLS,
	trackMcpUrl,
	trackTriageInput,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** What was made, and where Track's webhook posts. */
export interface TrackTriageSetUp {
	agentId: string;
	agentName: string;
	triggerId: string;
	url: string;
}

export const setUpTrackTriage = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), triage: trackTriageInput }))
	.handler(async ({ data }): Promise<TrackTriageSetUp> => {
		const [{ currentMember }, { isAdmin }, { registryFor }, { appOrigin }, runtime] =
			await Promise.all([
				import("#/server/access"),
				import("#/lib/roles"),
				import("#/server/registry"),
				import("#/server/origin"),
				import("@gateweave/agents-runtime"),
			]);
		const member = await currentMember(data.slug);
		if (!member) throw new Error("Workspace not found");
		if (!isAdmin(member.membership.role)) throw new Error("Only admins can do this");
		const { trackUrl, agentKey } = data.triage;

		// The key lives in this request's memory for the check; then only the registry keeps it.
		const check = await runtime.checkMcpServer({
			name: TRACK_TRIAGE_NAMES.mcpServer,
			transport: "http",
			url: trackMcpUrl(trackUrl),
			headers: { Authorization: `Bearer ${agentKey}` },
			tools: null,
		});
		if (!check.ok) throw new Error(`Track did not answer with this key: ${check.error}`);
		const offered = new Set(check.tools.map((tool) => tool.name));
		const missing = TRACK_TRIAGE_TOOLS.filter((tool) => !offered.has(tool));
		if (missing.length > 0) {
			throw new Error(
				`This Track has no ${missing.join(", ")} tool; it may need an update before it can be triaged`,
			);
		}

		const { workspaceId } = member.membership;
		const registry = registryFor(workspaceId);
		const { default: instructions } = await import("#/server/track-triage.md?raw");
		const { name, email, id } = member.user;
		const made = await registry.setUpTrackTriage(
			{ ...data.triage, instructions },
			id,
			name || email,
		);
		if ("status" in made) throw new Error(made.message);
		// The MCP page shows the server as checked, with the tools Track offered.
		await registry.recordMcpCheck(made.mcpServerId, check);
		return {
			agentId: made.agent.id,
			agentName: made.agent.name,
			triggerId: made.trigger.id,
			url: `${appOrigin()}/api/triggers/${workspaceId}/${made.trigger.id}`,
		};
	});
