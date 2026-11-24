import { trackSourceOrigin } from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const workspace = z.object({ slug: z.string().min(1) });

async function sourceAdmin(slug: string) {
	const { currentMember } = await import("#/server/access");
	const { isAdmin } = await import("#/lib/roles");
	const member = await currentMember(slug);
	if (!member) throw new Error("Workspace not found");
	if (!isAdmin(member.membership.role)) throw new Error("Only admins can do this");
	return member;
}

export const beginTrackSource = createServerFn({ method: "POST" })
	.validator(workspace.extend({ trackUrl: trackSourceOrigin }))
	.handler(async ({ data }) => {
		const { demoEnabled, OFF_IN_DEMO } = await import("#/server/demo/mode");
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		const member = await sourceAdmin(data.slug);
		const { registryFor } = await import("#/server/registry");
		const { appOrigin } = await import("#/server/origin");
		const { beginSourceConnect } = await import("#/server/track-connect");
		return beginSourceConnect(
			registryFor(member.membership),
			member.user.id,
			member.membership.workspaceId,
			data.trackUrl,
			appOrigin(),
		);
	});

export const getTrackSources = createServerFn({ method: "GET" })
	.validator(workspace)
	.handler(async ({ data }) => {
		const member = await sourceAdmin(data.slug);
		const { demoEnabled } = await import("#/server/demo/mode");
		if (demoEnabled()) return [];
		const { registryFor } = await import("#/server/registry");
		return registryFor(member.membership).listTrackSources();
	});

export const disconnectTrackSource = createServerFn({ method: "POST" })
	.validator(workspace.extend({ connectionId: z.uuid() }))
	.handler(async ({ data }) => {
		const { demoEnabled, OFF_IN_DEMO } = await import("#/server/demo/mode");
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		const member = await sourceAdmin(data.slug);
		const { registryFor } = await import("#/server/registry");
		return registryFor(member.membership).removeTrackSource(data.connectionId);
	});
