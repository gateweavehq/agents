/**
 * Conversations with agents run by Gateweave, and with teams of them. Each belongs to the member
 * who started it: these functions list, open and delete only the caller's own. The messages
 * themselves travel over the conversation's WebSocket, through the gateway in `src/server/chat.ts`.
 */
import type { Conversation, ModelProvider, Run, TeamDetail } from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const id = z.string().min(1).max(64);

/** An agent someone can talk to, and whether the workspace has a key for its provider. */
export interface ChatAgent {
	id: string;
	name: string;
	description: string | null;
	provider: ModelProvider;
	model: string;
	keyed: boolean;
}

/** A team someone can talk to. Its lead answers, so the team answers only while it has one. */
export interface ChatTeam {
	id: string;
	name: string;
	description: string | null;
	members: number;
	leadName: string;
	/** Its lead, unless the lead was removed. */
	lead: ChatAgent | null;
}

/** An agent at work in a conversation: the one answering, or one a team's edge reached. */
export type ChatActivity = Pick<Run, "id" | "agentId" | "agentName" | "edge" | "teamPath">;

async function memberOf(slug: string) {
	const { currentMember } = await import("#/server/access");
	const member = await currentMember(slug);
	if (!member) return null;
	const { registryFor } = await import("#/server/registry");
	return {
		userId: member.user.id,
		workspaceId: member.membership.workspaceId,
		registry: registryFor(member.membership.workspaceId),
	};
}

/** The agents run by Gateweave, with the providers the workspace has keys for. */
async function chatAgents(registry: NonNullable<Awaited<ReturnType<typeof memberOf>>>["registry"]) {
	const [agents, keys] = await Promise.all([
		registry.listRunnableAgents(),
		registry.listProviderKeys(),
	]);
	const keyed = new Set(keys.map((key) => key.provider));
	return agents.map(
		({ id, name, description, provider, model }): ChatAgent => ({
			id,
			name,
			description,
			provider,
			model,
			keyed: keyed.has(provider),
		}),
	);
}

/**
 * The caller's conversations, the latest first, and the agents and teams they can start one with.
 */
export const getChats = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({
			data: slug,
		}): Promise<{
			conversations: Conversation[];
			agents: ChatAgent[];
			teams: ChatTeam[];
		} | null> => {
			const member = await memberOf(slug);
			if (!member) return null;
			const [conversations, agents, teams] = await Promise.all([
				member.registry.listConversations(member.userId),
				chatAgents(member.registry),
				member.registry.listTeams(),
			]);
			return {
				conversations,
				agents,
				teams: teams.map(
					({ team, lead, members }): ChatTeam => ({
						id: team.id,
						name: team.name,
						description: team.description,
						members,
						leadName: lead.name,
						lead: agents.find((agent) => agent.id === lead.id) ?? null,
					}),
				),
			};
		},
	);

/**
 * One of the caller's conversations, with the agent that answers it: its agent, or its team's lead
 * as it is now. The agent is null once it was removed, or the team was deleted; the team is null
 * for a conversation with one agent, and once the team was deleted.
 */
export const getChat = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), conversationId: id }))
	.handler(
		async ({
			data,
		}): Promise<{
			conversation: Conversation;
			agent: ChatAgent | null;
			team: TeamDetail | null;
		} | null> => {
			const member = await memberOf(data.slug);
			if (!member) return null;
			const conversation = await member.registry.getConversation(
				data.conversationId,
				member.userId,
			);
			if (!conversation) return null;
			const [agents, team] = await Promise.all([
				chatAgents(member.registry),
				conversation.teamId === null ? null : member.registry.getTeam(conversation.teamId),
			]);
			const answers = conversation.teamId === null ? conversation.agentId : team?.team.leadAgentId;
			return {
				conversation,
				agent: agents.find((agent) => agent.id === answers) ?? null,
				team,
			};
		},
	);

/**
 * The agents at work in one of the caller's conversations, for the team beside it to show; null
 * when it is not theirs.
 */
export const getChatActivity = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), conversationId: id }))
	.handler(async ({ data }): Promise<ChatActivity[] | null> => {
		const member = await memberOf(data.slug);
		if (!member) return null;
		const runs = await member.registry.activeRuns(data.conversationId, member.userId);
		return (
			runs?.map(({ id, agentId, agentName, edge, teamPath }) => ({
				id,
				agentId,
				agentName,
				edge,
				teamPath,
			})) ?? null
		);
	});

export const startChat = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), agentId: id }))
	.handler(async ({ data }): Promise<Conversation> => {
		const member = await memberOf(data.slug);
		if (!member) throw new Error("Workspace not found");
		const conversation = await member.registry.startConversation(data.agentId, member.userId);
		if (!conversation) throw new Error("That agent was removed or cannot chat");
		return conversation;
	});

export const startTeamChat = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), teamId: id }))
	.handler(async ({ data }): Promise<Conversation> => {
		const member = await memberOf(data.slug);
		if (!member) throw new Error("Workspace not found");
		const conversation = await member.registry.startTeamConversation(data.teamId, member.userId);
		if (!conversation) throw new Error("That team was deleted, or its lead was removed");
		return conversation;
	});

/**
 * Deletes one of the caller's conversations with its messages, and the conversations its team's
 * nested turns ran in.
 */
export const removeChat = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), conversationId: id }))
	.handler(async ({ data }): Promise<void> => {
		const member = await memberOf(data.slug);
		if (!member) throw new Error("Workspace not found");
		const removed = await member.registry.removeConversation(data.conversationId, member.userId);
		if (removed.length === 0) throw new Error("Conversation not found");
		const [{ env }, { getAgentByName }, { conversationName }] = await Promise.all([
			import("cloudflare:workers"),
			import("agents"),
			import("@gateweave/agents-runtime"),
		]);
		await Promise.all(
			removed.map(async (conversationId) => {
				const conversation = await getAgentByName(
					env.CONVERSATIONS,
					conversationName(member.workspaceId, conversationId),
				);
				await conversation.destroy();
			}),
		);
	});
