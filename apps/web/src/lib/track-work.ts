/**
 * An agent that works on the Gateweave Track issues assigned to it, in one click, for owners and
 * admins: the registry makes the agent, with a sandbox on the chosen repository, its instructions,
 * an environment set with the Track agent member's key, Track's MCP server and a trigger for the
 * issues assigned to that member (see `TRACK_WORK_*` in the model). The key is tried on Track's
 * MCP server first, which also says which member it is, so nothing is made with a key that fails.
 */
import {
	TRACK_WORK_NAMES,
	TRACK_WORK_TOOLS,
	trackMcpUrl,
	trackWorkInput,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** What was made, and where Track's webhook posts. */
export interface TrackWorkSetUp {
	agentId: string;
	agentName: string;
	triggerId: string;
	url: string;
	/** The agent member's name in Track, which people assign issues to. */
	memberName: string;
}

export const setUpTrackWork = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), work: trackWorkInput }))
	.handler(async ({ data }): Promise<TrackWorkSetUp> => {
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
		const { trackUrl, agentKey } = data.work;

		// The key lives in this request's memory for the check; then only the registry keeps it.
		const { check, identity } = await runtime.checkTrackAgent({
			name: TRACK_WORK_NAMES.mcpServer,
			transport: "http",
			url: trackMcpUrl(trackUrl),
			headers: { Authorization: `Bearer ${agentKey}` },
			tools: null,
		});
		if (!check.ok) throw new Error(`Track did not answer with this key: ${check.error}`);
		const offered = new Set(check.tools.map((tool) => tool.name));
		const missing = TRACK_WORK_TOOLS.filter((tool) => !offered.has(tool));
		if (missing.length > 0) {
			throw new Error(`This Track has no ${missing.join(", ")} tool; it needs an update first`);
		}
		if ("problem" in identity) throw new Error(identity.problem);

		const { workspaceId } = member.membership;
		const registry = registryFor(workspaceId);
		const { default: instructions } = await import("#/server/track-work.md?raw");
		const { name, email, id } = member.user;
		const made = await registry.setUpTrackWork(
			{ ...data.work, instructions, memberId: identity.memberId },
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
			memberName: identity.name,
		};
	});
