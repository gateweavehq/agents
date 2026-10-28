/**
 * Conversations with agents run by Gateweave. Each belongs to the member who started it: these
 * functions list, open and delete only the caller's own. The messages themselves travel over the
 * conversation's WebSocket, through the gateway in `src/server/chat.ts`.
 */
import type { Conversation, ModelProvider } from "@gateweave/agents-model";
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
	const [agents, keys] = await Promise.all([registry.listAgents(), registry.listProviderKeys()]);
	const keyed = new Set(keys.map((key) => key.provider));
	const runnable = agents.filter((agent) => agent.runtime === "gateweave");
	const details = await Promise.all(runnable.map((agent) => registry.getAgent(agent.id)));
	return details.flatMap((detail): ChatAgent[] => {
		const definition = detail?.definition;
		if (!detail || !definition) return [];
		const { id, name, description } = detail.agent;
		const { provider, model } = definition;
		return [{ id, name, description, provider, model, keyed: keyed.has(provider) }];
	});
}

/** The caller's conversations, the latest first, and the agents they can start one with. */
export const getChats = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({
			data: slug,
		}): Promise<{ conversations: Conversation[]; agents: ChatAgent[] } | null> => {
			const member = await memberOf(slug);
			if (!member) return null;
			const [conversations, agents] = await Promise.all([
				member.registry.listConversations(member.userId),
				chatAgents(member.registry),
			]);
			return { conversations, agents };
		},
	);

/** One of the caller's conversations, with its agent unless the agent was removed. */
export const getChat = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), conversationId: id }))
	.handler(
		async ({ data }): Promise<{ conversation: Conversation; agent: ChatAgent | null } | null> => {
			const member = await memberOf(data.slug);
			if (!member) return null;
			const conversation = await member.registry.getConversation(
				data.conversationId,
				member.userId,
			);
			if (!conversation) return null;
			const agents = await chatAgents(member.registry);
			return {
				conversation,
				agent: agents.find((agent) => agent.id === conversation.agentId) ?? null,
			};
		},
	);

export const startChat = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), agentId: id }))
	.handler(async ({ data }): Promise<Conversation> => {
		const member = await memberOf(data.slug);
		if (!member) throw new Error("Workspace not found");
		const conversation = await member.registry.startConversation(data.agentId, member.userId);
		if (!conversation) throw new Error("That agent was removed or cannot chat");
		return conversation;
	});

/** Deletes one of the caller's conversations with its messages. */
export const removeChat = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), conversationId: id }))
	.handler(async ({ data }): Promise<void> => {
		const member = await memberOf(data.slug);
		if (!member) throw new Error("Workspace not found");
		const removed = await member.registry.removeConversation(data.conversationId, member.userId);
		if (!removed) throw new Error("Conversation not found");
		const [{ env }, { getAgentByName }, { conversationName }] = await Promise.all([
			import("cloudflare:workers"),
			import("agents"),
			import("@gateweave/agents-runtime"),
		]);
		const conversation = await getAgentByName(
			env.CONVERSATIONS,
			conversationName(member.workspaceId, data.conversationId),
		);
		await conversation.destroy();
	});
