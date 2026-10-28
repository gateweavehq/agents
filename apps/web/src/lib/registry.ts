import type { Overview } from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** How much the workspace's registry holds, or null if the caller may not see the workspace. */
export const getOverview = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<Overview | null> => {
		const { currentMember } = await import("#/server/access");
		const member = await currentMember(slug);
		if (!member) return null;
		const { registryFor } = await import("#/server/registry");
		const { projects, repositories, agents, assets } = await registryFor(
			member.membership.workspaceId,
		).overview();
		return { projects, repositories, agents, assets };
	});
