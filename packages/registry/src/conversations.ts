/**
 * The index of conversations with agents run by Gateweave. A conversation's messages live in its
 * own Durable Object in the runtime; the registry knows which conversations exist, whose they
 * are, which agent or team they talk to, and when they last moved. Each belongs to the member who
 * started it, and nobody else can list or open it.
 *
 * A turn a team's agent takes over an edge runs in a conversation of its own, which goes with the
 * conversation the person started (`root_id`). Those are not listed or opened here, and go when
 * that conversation goes.
 *
 * A trigger's delivery runs in a conversation with no person in it (`./triggers.ts`), which
 * `started_by` names the trigger in, so it is nobody's to list, open or go on with.
 */
import type { AgentSnapshot, Conversation, TurnEdge, TurnMcpServer } from "@gateweave/agents-model";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { agentDefinitions, agents, conversations, teams } from "./db/schema";
import type { Db } from "./state";

/**
 * What a turn needs: the agent as it is now, the workspace's key for its provider, opened (none
 * for Workers AI, which the runtime reaches with the deployment's own token), the agent's MCP
 * servers with their headers' secrets, opened too, the edges it can take in a team, and the run
 * the registry opened for it.
 */
export interface ConversationTurn {
	agent: AgentSnapshot;
	key: string | null;
	mcpServers: TurnMcpServer[];
	edges: TurnEdge[];
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
	const row = newRow({ agentId, startedBy, teamId: null, rootId: null, title: null }, now);
	db.insert(conversations).values(row).run();
	return toConversation(row, agent.name, null, null);
}

/** Null when there is no such team, or its lead was removed, so nobody would answer. */
export function startTeamConversation(
	db: Db,
	teamId: string,
	startedBy: string,
	now: number,
): Conversation | null {
	const team = db
		.select({ name: teams.name, leadAgentId: teams.leadAgentId, leadName: agents.name })
		.from(teams)
		.innerJoin(agents, eq(agents.id, teams.leadAgentId))
		.where(and(eq(teams.id, teamId), isNull(agents.removedAt)))
		.get();
	if (!team) return null;
	const row = newRow(
		{ agentId: team.leadAgentId, startedBy, teamId, rootId: null, title: null },
		now,
	);
	db.insert(conversations).values(row).run();
	return toConversation(row, team.leadName, null, team.name);
}

/**
 * The conversation a nested turn runs in, made as the turn begins, with the id the runtime chose
 * for it. False when that id is taken, since each nested turn has a conversation of its own.
 */
export function startNestedConversation(
	db: Db,
	row: { id: string; agentId: string; startedBy: string; rootId: string; text: string },
	now: number,
): boolean {
	const { id, text, ...parties } = row;
	const taken = db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.id, id))
		.get();
	if (taken) return false;
	const values = { ...newRow({ ...parties, teamId: null, title: titleOf(text) }, now), id };
	db.insert(conversations).values(values).run();
	return true;
}

/**
 * The member's conversations, the latest first; with `agentId`, only those with that agent. The
 * ones nested turns ran in are not among them.
 */
export function listConversations(db: Db, startedBy: string, agentId?: string): Conversation[] {
	return selectConversations(db)
		.where(
			and(
				eq(conversations.startedBy, startedBy),
				isNull(conversations.rootId),
				agentId === undefined ? undefined : eq(conversations.agentId, agentId),
			),
		)
		.orderBy(desc(conversations.updatedAt))
		.all()
		.map(({ conversation, agentName, agentRemovedAt, teamName }) =>
			toConversation(conversation, agentName, agentRemovedAt, teamName),
		);
}

/** Null unless the member started it. A conversation a nested turn ran in is not opened here. */
export function getConversation(db: Db, id: string, startedBy: string): Conversation | null {
	const found = selectConversations(db)
		.where(
			and(
				eq(conversations.id, id),
				eq(conversations.startedBy, startedBy),
				isNull(conversations.rootId),
			),
		)
		.get();
	return found
		? toConversation(found.conversation, found.agentName, found.agentRemovedAt, found.teamName)
		: null;
}

/**
 * Whom a conversation belongs to, which agent or team it talks to, and, for one a nested turn ran
 * in, the conversation it goes with. Null when there is none.
 */
export function conversationParties(
	db: Db,
	id: string,
): {
	agentId: string;
	startedBy: string;
	teamId: string | null;
	rootId: string | null;
	triggerId: string | null;
} | null {
	return (
		db
			.select({
				agentId: conversations.agentId,
				startedBy: conversations.startedBy,
				teamId: conversations.teamId,
				rootId: conversations.rootId,
				triggerId: conversations.triggerId,
			})
			.from(conversations)
			.where(eq(conversations.id, id))
			.get() ?? null
	);
}

/**
 * Deletes a conversation the member started, with the ones its nested turns ran in. Returns the
 * ids of all of them, whose messages the runtime clears; none when there was no such conversation.
 */
export function removeConversation(db: Db, id: string, startedBy: string): string[] {
	const removed = db
		.delete(conversations)
		.where(
			and(
				eq(conversations.id, id),
				eq(conversations.startedBy, startedBy),
				isNull(conversations.rootId),
			),
		)
		.returning({ id: conversations.id })
		.get();
	if (!removed) return [];
	const nested = db
		.delete(conversations)
		.where(eq(conversations.rootId, id))
		.returning({ id: conversations.id })
		.all();
	return [id, ...nested.map((row) => row.id)];
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

function newRow(
	parties: Omit<typeof conversations.$inferInsert, "id" | "createdAt" | "updatedAt">,
	now: number,
): typeof conversations.$inferSelect {
	return {
		id: crypto.randomUUID(),
		title: null,
		teamId: null,
		rootId: null,
		triggerId: null,
		...parties,
		createdAt: now,
		updatedAt: now,
	};
}

function selectConversations(db: Db) {
	return db
		.select({
			conversation: conversations,
			agentName: agents.name,
			agentRemovedAt: agents.removedAt,
			teamName: teams.name,
		})
		.from(conversations)
		.innerJoin(agents, eq(agents.id, conversations.agentId))
		.leftJoin(teams, eq(teams.id, conversations.teamId))
		.$dynamic();
}

function toConversation(
	{ startedBy: _, rootId: __, ...row }: typeof conversations.$inferSelect,
	agentName: string,
	agentRemovedAt: number | null,
	teamName: string | null,
): Conversation {
	return { ...row, agentName, agentRemoved: agentRemovedAt !== null, teamName };
}
