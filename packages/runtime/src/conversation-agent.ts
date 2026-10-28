import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { RunSpan } from "@gateweave/agents-model";
import type { RegistryDO } from "@gateweave/agents-registry";
import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	stepCountIs,
	streamText,
	type UIMessage,
} from "ai";
import { describeFailure, failureForLogs, type GatewaySettings, languageModel } from "./models";
import { connectTools } from "./tools";
import { closeInterruptedRuns, createTraceTables, RunRecorder, readTrace, type Sql } from "./trace";

interface RuntimeEnv extends GatewaySettings {
	REGISTRY: DurableObjectNamespace<RegistryDO>;
}

const SEPARATOR = ":";

/** The model requests one turn may make: the first, and one after each round of tool calls. */
export const MAX_STEPS = 10;

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
 *
 * Each turn that calls the model is a run. Its trace is kept here (`./trace.ts`) and its sum goes
 * to the registry when it ends. The agent's MCP servers are connected for each turn and closed
 * when it ends (`./tools.ts`).
 */
export class ConversationAgent extends AIChatAgent<Cloudflare.Env> {
	// The name holds the workspace's id, which the page has no use for.
	static override options = { sendIdentityOnConnect: false };

	#traceTables = false;

	override async onStart(): Promise<void> {
		// A restart cut these runs short: they will not end on their own.
		const interrupted = closeInterruptedRuns(this.#sql);
		if (interrupted.length === 0) return;
		const { registry } = this.#parties();
		await Promise.all(
			interrupted.map(({ runId, finish }) => this.#report(registry, runId, finish)),
		);
	}

	/** A run's trace, for the app's Runs page; none when this conversation has no such run. */
	runTrace(runId: string): RunSpan[] {
		if (typeof runId !== "string" || runId.length > 64) return [];
		return readTrace(this.#sql, runId);
	}

	override async onChatMessage(
		_onFinish: unknown,
		options?: OnChatMessageOptions,
	): Promise<Response> {
		const env = this.env as unknown as RuntimeEnv;
		const { workspaceId, conversationId, registry } = this.#parties();
		const turn = await registry.beginTurn(conversationId, lastUserText(this.messages));
		if ("status" in turn) return failed(turn.message);
		const { agent, key, mcpServers, runId } = turn;
		const run = new RunRecorder(this.#sql, runId, agent);
		const toolbox = await connectTools(mcpServers, run, options?.abortSignal);
		const end = async (status: "succeeded" | "failed" | "stopped", error: string | null = null) => {
			await toolbox.close();
			const finish = run.finish(status, error);
			if (finish) await this.#report(registry, runId, finish);
		};

		try {
			const result = streamText({
				model: languageModel(agent, key, env, {
					workspace: workspaceId,
					agent: agent.agentId,
					conversation: conversationId,
				}),
				system: agent.instructions ?? undefined,
				// A turn stopped during a tool call leaves the call without a result, which providers
				// refuse in a later turn.
				messages: await convertToModelMessages(this.messages, {
					tools: toolbox.tools,
					ignoreIncompleteToolCalls: true,
				}),
				tools: toolbox.tools,
				stopWhen: stepCountIs(MAX_STEPS),
				abortSignal: options?.abortSignal,
				onStepStart: ({ stepNumber }) => run.stepStarted(stepNumber),
				onStepEnd: (step) => run.stepEnded(step),
				onStepError: ({ stepNumber, error }) =>
					run.stepFailed(stepNumber, describeFailure(agent, error)),
				onEnd: ({ finishReason }) =>
					finishReason === "error"
						? end("failed", `${agent.name} could not finish its answer.`)
						: end("succeeded"),
				onAbort: () => end("stopped"),
				onError: ({ error }) => end("failed", describeFailure(agent, error)),
			});
			return result.toUIMessageStreamResponse({
				onError: (error) => {
					console.error("A turn failed", { agent: agent.agentId, ...failureForLogs(error) });
					return describeFailure(agent, error);
				},
			});
		} catch (error) {
			const message = describeFailure(agent, error);
			await end("failed", message);
			return failed(message);
		}
	}

	/** The conversation's SQLite, with the trace's tables made on first use. */
	get #sql(): Sql {
		const sql = this.sql.bind(this) as Sql;
		if (!this.#traceTables) {
			createTraceTables(sql);
			this.#traceTables = true;
		}
		return sql;
	}

	/** The workspace and conversation this is, from its name, and the workspace's registry. */
	#parties() {
		const env = this.env as unknown as RuntimeEnv;
		const [workspaceId = "", conversationId = ""] = this.name.split(SEPARATOR);
		return { workspaceId, conversationId, registry: env.REGISTRY.getByName(workspaceId) };
	}

	/** Tells the registry how a run ended. A failure to tell it is logged; the turn goes on. */
	async #report(
		registry: DurableObjectStub<RegistryDO>,
		runId: string,
		finish: Parameters<RegistryDO["finishRun"]>[1],
	): Promise<void> {
		try {
			await registry.finishRun(runId, finish);
		} catch (error) {
			console.error("A run's end was not recorded", { runId, ...failureForLogs(error) });
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
