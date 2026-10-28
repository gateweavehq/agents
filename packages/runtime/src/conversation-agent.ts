import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { RegistryDO } from "@gateweave/agents-registry";
import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	streamText,
	type UIMessage,
} from "ai";
import { describeFailure, failureForLogs, type GatewaySettings, languageModel } from "./models";

interface RuntimeEnv extends GatewaySettings {
	REGISTRY: DurableObjectNamespace<RegistryDO>;
}

const SEPARATOR = ":";

/** The name of a conversation's Durable Object: its workspace and its id. */
export function conversationName(workspaceId: string, conversationId: string): string {
	return `${workspaceId}${SEPARATOR}${conversationId}`;
}

/**
 * One conversation with an agent run by Gateweave: its messages, kept in its own SQLite, and the
 * turns that answer them, streamed to every tab that has it open and resumed after a reconnect.
 *
 * It has no public route. The app's chat gateway reaches it with `getAgentByName`, and only after
 * checking that the caller is the member who started the conversation, so it trusts whoever
 * connects. Each turn asks the workspace's registry for the agent as it is now and for the key
 * of its provider, so an edit to the agent or a new key applies from the next message, and the
 * key lives only as long as the turn.
 */
export class ConversationAgent extends AIChatAgent<Cloudflare.Env> {
	// The name holds the workspace's id, which the page has no use for.
	static override options = { sendIdentityOnConnect: false };

	override async onChatMessage(
		_onFinish: unknown,
		options?: OnChatMessageOptions,
	): Promise<Response> {
		const env = this.env as unknown as RuntimeEnv;
		const [workspaceId = "", conversationId = ""] = this.name.split(SEPARATOR);
		const registry = env.REGISTRY.getByName(workspaceId);
		const turn = await registry.beginTurn(conversationId, lastUserText(this.messages));
		if ("status" in turn) return failed(turn.message);
		const { agent, key } = turn;

		try {
			const result = streamText({
				model: languageModel(agent, key, env, {
					workspace: workspaceId,
					agent: agent.agentId,
					conversation: conversationId,
				}),
				system: agent.instructions ?? undefined,
				messages: await convertToModelMessages(this.messages),
				abortSignal: options?.abortSignal,
			});
			return result.toUIMessageStreamResponse({
				onError: (error) => {
					console.error("A turn failed", { agent: agent.agentId, ...failureForLogs(error) });
					return describeFailure(agent, error);
				},
			});
		} catch (error) {
			return failed(describeFailure(agent, error));
		}
	}

	/** Only the server changes the state, and this agent keeps none. */
	override validateStateChange(_state: unknown, source: unknown): void {
		if (source !== "server") throw new Error("This conversation's state is not changed here");
	}
}

/** The text of the latest message from the person chatting. */
function lastUserText(messages: UIMessage[]): string {
	const message = messages.findLast((candidate) => candidate.role === "user");
	return (message?.parts ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
}

/** A turn that ends before the model is called, with why. */
function failed(message: string): Response {
	return createUIMessageStreamResponse({
		stream: createUIMessageStream({
			execute: ({ writer }) => writer.write({ type: "error", errorText: message }),
		}),
	});
}
