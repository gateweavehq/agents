import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** The signed-in user's membership in the workspace with this slug, or null. */
export const getWorkspace = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { currentMember } = await import("#/server/access");
		const { legalLinks } = await import("#/server/legal");
		const { demoEnabled } = await import("#/server/demo/mode");
		const member = await currentMember(slug);
		if (!member) return null;
		const { user, membership } = member;
		return {
			id: membership.workspaceId,
			slug,
			name: membership.workspaceName,
			role: membership.role,
			userId: user.id,
			user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
			legal: legalLinks(),
			/** A sandbox of the public demo, which says so on every page. */
			demo: demoEnabled(),
			/** On the demo, when the visitor was made (ms), which is what cleanup counts a day from. */
			demoCreatedAt: demoEnabled() ? new Date(user.createdAt).getTime() : undefined,
		};
	});

export type Workspace = NonNullable<Awaited<ReturnType<typeof getWorkspace>>>;
