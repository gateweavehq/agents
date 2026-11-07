import {
	type ChatSession,
	ConversationAgent as RuntimeConversationAgent,
} from "@gateweave/agents-runtime";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";

/**
 * Conversations as this app runs them. A chat socket stops taking messages once its session is
 * gone from D1, which is where every way of ending one ends up: signing out, revoking it, a
 * password reset and the provider's logout. It stops too once its person has left the workspace,
 * however they came to, since a socket can stay open for as long as a tab does, and until then it
 * would go on spending the workspace's keys with the workspace's tools.
 */
export class ConversationAgent extends RuntimeConversationAgent {
	protected override async sessionHolds(
		session: ChatSession,
		workspaceId: string,
	): Promise<boolean> {
		const row = await db
			.select({ id: schema.session.id })
			.from(schema.session)
			.innerJoin(
				schema.member,
				and(
					eq(schema.member.userId, schema.session.userId),
					eq(schema.member.organizationId, workspaceId),
				),
			)
			.where(
				and(
					eq(schema.session.id, session.id),
					eq(schema.session.userId, session.userId),
					gt(schema.session.expiresAt, new Date()),
				),
			)
			.get();
		return row !== undefined;
	}
}
