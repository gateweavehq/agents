import type { AgentSnapshot } from "@gateweave/agents-model";
import {
	type ChatSession,
	createTraceTables,
	type GatewayMetadata,
	ConversationAgent as RuntimeConversationAgent,
	recordPastRun,
	type Sql,
} from "@gateweave/agents-runtime";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { assertDemo, demoEnabled } from "./demo/mode";
import type { PastConversation } from "./demo/sample";
import { scriptedModel } from "./demo/scripted-model";

/**
 * Conversations as this app runs them. A chat socket stops taking messages once its session is
 * gone from D1, which is where every way of ending one ends up: signing out, revoking it, a
 * password reset and the provider's logout. It stops too once its person has left the workspace,
 * however they came to, since a socket can stay open for as long as a tab does, and until then it
 * would go on spending the workspace's keys with the workspace's tools.
 *
 * On the public demo, agents answer with the scripted model, and no request leaves for a provider.
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

	protected override modelFor(agent: AgentSnapshot, key: string | null, metadata: GatewayMetadata) {
		return demoEnabled() ? scriptedModel(agent) : super.modelFor(agent, key, metadata);
	}

	/**
	 * Takes a past conversation of a new demo sandbox: its messages, and its runs' traces as they
	 * would have been recorded. For the demo's registry alone, as it fills the sandbox.
	 */
	async fillDemo(past: PastConversation): Promise<void> {
		assertDemo();
		const sql = this.sql.bind(this) as Sql;
		createTraceTables(sql);
		for (const run of past.runs) {
			recordPastRun(
				sql,
				{ id: run.id, status: "succeeded", startedAt: run.startedAt, endedAt: run.endedAt },
				run.spans,
			);
		}
		await this.persistMessages(past.messages);
	}
}
