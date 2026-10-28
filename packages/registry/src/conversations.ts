/**
 * The index of conversations with agents run by Gateweave. A conversation's messages live in its
 * own Durable Object in the runtime; the registry knows which conversations exist, whose they
 * are, which agent they talk to, and when they last moved. Each belongs to the member who started
 * it, and nobody else can list or open it.
 */
import type { AgentSnapshot, Conversation, TurnMcpServer } from "@gateweave/agents-model";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { agentDefinitions, agents, conversations } from "./db/schema";
import type { Db } from "./state";

/**
 * What a turn needs: the agent as it is now, the workspace's key for its provider, opened, the
 * agent's MCP servers with their headers' secrets, opened too, and the run the registry opened
 * for it.
 */
export interface ConversationTurn {
	agent: AgentSnapshot;
	key: string;
	mcpServers: TurnMcpServer[];
	runId: string;
}

/** A conversation's title is the start of its first message, up to this many characters. */
export const TITLE_LENGTH = 80;

/** Null when the agent is not a live agent run by Gateweave. */
export function startConversation(
	db: Db,
	agentId: string,
	startedBy: string,
	now: number,
): Conversation | null {
	const agent = db
		.select({ name: agents.name })
		.from(agents)
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.where(and(eq(agents.id, agentId), isNull(agents.removedAt)))
		.get();
	if (!agent) return null;
	const row = {
		id: crypto.randomUUID(),
		agentId,
		startedBy,
		title: null,
		createdAt: now,
		updatedAt: now,
	};
	db.insert(conversations).values(row).run();
	return toConversation(row, agent.name, null);
}

/** The member's conversations, the latest first; with `agentId`, only those with that agent. */
export function listConversations(db: Db, startedBy: string, agentId?: string): Conversation[] {
	return selectConversations(db)
		.where(
			and(
				eq(conversations.startedBy, startedBy),
				agentId === undefined ? undefined : eq(conversations.agentId, agentId),
			),
		)
		.orderBy(desc(conversations.updatedAt))
		.all()
		.map(({ conversation, agentName, agentRemovedAt }) =>
			toConversation(conversation, agentName, agentRemovedAt),
		);
}

/** Null unless the member started it. */
export function getConversation(db: Db, id: string, startedBy: string): Conversation | null {
	const found = selectConversations(db)
		.where(and(eq(conversations.id, id), eq(conversations.startedBy, startedBy)))
		.get();
	return found ? toConversation(found.conversation, found.agentName, found.agentRemovedAt) : null;
}

/** Whom a conversation belongs to and which agent it talks to; null when there is none. */
export function conversationParties(
	db: Db,
	id: string,
): { agentId: string; startedBy: string } | null {
	return (
		db
			.select({ agentId: conversations.agentId, startedBy: conversations.startedBy })
			.from(conversations)
			.where(eq(conversations.id, id))
			.get() ?? null
	);
}

/** Only the member who started it can delete it. */
export function removeConversation(db: Db, id: string, startedBy: string): boolean {
	const removed = db
		.delete(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.startedBy, startedBy)))
		.returning({ id: conversations.id })
		.get();
	return removed !== undefined;
}

/**
 * Notes that a turn started: the conversation moves to the top of its member's list, and takes
 * the start of `text` as its title unless it has one.
 */
export function noteTurn(db: Db, id: string, text: string, now: number): void {
	db.update(conversations)
		.set({ updatedAt: now, title: sql`coalesce(${conversations.title}, ${titleOf(text)})` })
		.where(eq(conversations.id, id))
		.run();
}

function titleOf(text: string): string | null {
	const characters = Array.from(text.replace(/\s+/g, " ").trim());
	if (characters.length === 0) return null;
	return characters.length > TITLE_LENGTH
		? `${characters
				.slice(0, TITLE_LENGTH - 1)
				.join("")
				.trimEnd()}…`
		: characters.join("");
}

function selectConversations(db: Db) {
	return db
		.select({
			conversation: conversations,
			agentName: agents.name,
			agentRemovedAt: agents.removedAt,
		})
		.from(conversations)
		.innerJoin(agents, eq(agents.id, conversations.agentId))
		.$dynamic();
}

function toConversation(
	{ startedBy: _, ...row }: typeof conversations.$inferSelect,
	agentName: string,
	agentRemovedAt: number | null,
): Conversation {
	return { ...row, agentName, agentRemoved: agentRemovedAt !== null };
}
