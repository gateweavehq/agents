import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

/** The signed-in user's membership in the workspace with this slug, or null. */
export const getWorkspace = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { getAuth, db } = await import("#/server/auth");
		const auth = getAuth();
		const { findMembership } = await import("#/server/workspaces");
		const session = await auth.api.getSession({ headers: getRequestHeaders() });
		if (!session) return null;
		const membership = await findMembership(db, slug, session.user.id);
		if (!membership) return null;
		return {
			id: membership.workspaceId,
			slug,
			name: membership.workspaceName,
			role: membership.role,
			userId: session.user.id,
			user: {
				id: session.user.id,
				name: session.user.name,
				email: session.user.email,
				image: session.user.image ?? null,
			},
		};
	});

export type Workspace = NonNullable<Awaited<ReturnType<typeof getWorkspace>>>;
