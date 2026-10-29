import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { sharedApp } from "@gateweave/agents-github";
import {
	type AgentSnapshot,
	conversationBranch,
	type PullRequestOutcome,
	providerMissing,
	type RunSpan,
	SANDBOX_NOT_OFFERED,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
	type TriggerTurnOutcome,
	type TurnEdge,
	type TurnVia,
	type WorkersAiSettings,
} from "@gateweave/agents-model";
import type { ConversationTurn, RegistryDO } from "@gateweave/agents-registry";
import { type Agent, getAgentByName } from "agents";
import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	stepCountIs,
	streamText,
	type UIMessage,
} from "ai";
import { type CheckoutPort, repositoryNote, withCheckout } from "./checkout";
import {
	type ClaudeCodePort,
	ClaudeCodeTurn,
	claudeCodeNote,
	historyOf,
	linesOf,
} from "./claude-code";
import { edgeTools } from "./edges";
import {
	describeFailure,
	failureForLogs,
	type GatewaySettings,
	gatewayOf,
	languageModel,
	SettingsError,
} from "./models";
import {
	COMMIT_EMAIL,
	type CommitAuthor,
	gitHubPullRequests,
	type PullRequestPort,
	type PushPort,
	pullRequestTools,
} from "./pull-requests";
import { SANDBOX_ROOT, sandboxTools } from "./sandbox-tools";
import { connectTools } from "./tools";
import { closeInterruptedRuns, createTraceTables, RunRecorder, readTrace, type Sql } from "./trace";

interface RuntimeEnv extends GatewaySettings, WorkersAiSettings {
	REGISTRY: DurableObjectNamespace<RegistryDO>;
	CONVERSATIONS: DurableObjectNamespace<Agent<Cloudflare.Env>>;
	/** Each conversation's sandbox (`./sandbox.ts`), where the deployment offers them. */
	SANDBOX?: DurableObjectNamespace;
	/** The deployment's GitHub App, which opens the pull requests a sandbox's work goes into. */
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
}

/** What a conversation reaches of its sandbox over RPC. */
interface Sandbox extends CheckoutPort, PushPort, ClaudeCodePort {
	destroy(): Promise<void>;
}

const SEPARATOR = ":";

/** The model requests one turn may make: the first, and one after each round of tool calls. */
export const MAX_STEPS = 10;

/** The same for a turn with a sandbox, whose work takes many small steps. */
export const MAX_SANDBOX_STEPS = 40;

/** Most characters of a nested turn's answer that the model which asked for it reads. */
export const MAX_ANSWER = 50_000;

/** A turn that a turn of another conversation asks for over a team's edge. */
export interface NestedTurnRequest {
	text: string;
	via: TurnVia;
}

/** How a nested turn went: its run and answer (none for a report), or why it had none. */
export type NestedTurnOutcome =
	| { runId: string; answer: string | null }
	| { runId: string | null; error: string };

/** How a trigger's turn began: its run, or why it could not. */
export type { TriggerTurnOutcome };

/**
 * What a conversation reaches of another over RPC. Narrower than the class's own stub, whose type
 * TypeScript cannot work out from inside the class.
 */
interface NestedConversation {
	nestedTurn(request: NestedTurnRequest): Promise<NestedTurnOutcome>;
	stopNestedTurn(): Promise<void>;
	destroy(): Promise<void>;
}

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
 *
 * An agent with a sandbox also has tools that run commands and edit files on a Linux machine of
 * the conversation's own (`./sandbox.ts`), which goes when the conversation is deleted. With a
 * repository, the sandbox checks it out on a branch of the conversation's own, and
 * `open_pull_request` proposes the work from there (`./pull-requests.ts`).
 *
 * An agent whose engine is Claude Code takes its turns differently: Claude Code runs in the sandbox
 * with its own tools, and the turn passes on what it does (`./claude-code.ts`).
 *
 * In a conversation with a team, the lead's turn also has the team's edges as tools
 * (`./edges.ts`). Taking one starts a nested turn in a new conversation of the same class, reached
 * over RPC alone (`nestedTurn`); it begins with the edge it came through, which the registry
 * checks, and never takes another message.
 *
 * A trigger's delivery starts a turn the same way, over RPC from the app's gateway
 * (`triggerTurn`), in a conversation the registry opened for that delivery alone.
 */
export class ConversationAgent extends AIChatAgent<Cloudflare.Env> {
	// The name holds the workspace's id, which the page has no use for.
	static override options = { sendIdentityOnConnect: false };

	#traceTables = false;
	/** The turn `nestedTurn` or `triggerTurn` began, which the next `onChatMessage` takes up. */
	#begun: ConversationTurn | null = null;
	/** Stops the nested turn under way, when the turn waiting for it stops. */
	#stopNested: AbortController | null = null;
	/** Why the turn under way failed, in the app's words; null while it has not. */
	#failure: string | null = null;

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

	/**
	 * Takes the one turn this conversation exists for, which a turn of another conversation asked
	 * for over a team's edge. The registry checks the edge and begins the turn; then a delegate or
	 * an ask waits for the answer, and a report only for the start.
	 */
	async nestedTurn({ text, via }: NestedTurnRequest): Promise<NestedTurnOutcome> {
		const { conversationId, registry } = this.#parties();
		const turn = await registry.beginTurn(conversationId, text, via);
		if ("status" in turn) return { runId: null, error: turn.message };
		this.#begun = turn;
		const stop = new AbortController();
		this.#stopNested = stop;
		const message: UIMessage = {
			id: crypto.randomUUID(),
			role: "user",
			parts: [{ type: "text", text }],
		};
		const done = this.saveMessages((messages) => [...messages, message], { signal: stop.signal });
		if (via.kind === "report") {
			// Nobody waits for it, so the conversation stays awake until it ends.
			this.keepAliveWhile(() => done).catch((error: unknown) =>
				console.error("A reported turn failed", failureForLogs(error)),
			);
			return { runId: turn.runId, answer: null };
		}
		const result = await done;
		if (this.#failure !== null) return { runId: turn.runId, error: this.#failure };
		if (result.status === "aborted") return { runId: turn.runId, error: "The turn was stopped" };
		if (result.status !== "completed") {
			return { runId: turn.runId, error: `${turn.agent.name} could not finish its answer` };
		}
		return { runId: turn.runId, answer: answerOf(this.messages, turn.agent.name) };
	}

	/** Stops the nested turn under way. */
	stopNestedTurn(): void {
		this.#stopNested?.abort();
	}

	/**
	 * Takes the one turn a trigger's delivery opened this conversation for, with the trigger's
	 * message. The registry checks the conversation and begins the run. Nobody waits for the
	 * answer, so the conversation stays awake until the turn ends.
	 */
	async triggerTurn(text: string): Promise<TriggerTurnOutcome> {
		const { conversationId, registry } = this.#parties();
		const turn = await registry.beginTriggerTurn(conversationId, text);
		if ("status" in turn) return { runId: null, error: turn.message };
		this.#begun = turn;
		const message: UIMessage = {
			id: crypto.randomUUID(),
			role: "user",
			parts: [{ type: "text", text }],
		};
		const done = this.saveMessages((messages) => [...messages, message]);
		this.keepAliveWhile(() => done).catch((error: unknown) =>
			console.error("A trigger's turn failed", failureForLogs(error)),
		);
		return { runId: turn.runId };
	}

	/**
	 * The conversation's messages as JSON, for an owner or admin reading a trigger's run: no person
	 * had that conversation, so nobody opens it in Chat. JSON, since what their tools took and gave
	 * back can be anything, which RPC's types do not carry.
	 */
	transcript(): string {
		return JSON.stringify(this.messages);
	}

	override async onChatMessage(
		_onFinish: unknown,
		options?: OnChatMessageOptions,
	): Promise<Response> {
		const env = this.env as unknown as RuntimeEnv;
		const { workspaceId, conversationId, registry } = this.#parties();
		const begun = this.#begun;
		this.#begun = null;
		this.#failure = null;
		const turn = begun ?? (await registry.beginTurn(conversationId, lastUserText(this.messages)));
		if ("status" in turn) return failed(turn.message);
		const { agent, key, mcpServers, edges, repository, runId } = turn;
		const sandbox = turn.sandbox ? this.#sandbox() : null;
		const branch = conversationBranch(conversationId);
		const run = new RunRecorder(this.#sql, runId, agent);
		if (agent.engine === "claude-code") {
			return this.#claudeCodeTurn(turn, run, options?.abortSignal);
		}
		const toolbox = await connectTools(mcpServers, run, options?.abortSignal);
		const checkedOut = sandbox && repository ? withCheckout(sandbox, repository, branch) : null;
		const github = repository ? this.#pullRequests(repository) : null;
		// A server's tools are named `<server>__<tool>`, so the sandbox's never clash with them. An
		// edge is named after a member of the team, so it wins over any tool of that name.
		const tools = {
			...toolbox.tools,
			...(sandbox ? sandboxTools(checkedOut ?? sandbox, run) : {}),
			...(sandbox && checkedOut && repository && github
				? pullRequestTools({
						sandbox,
						ready: checkedOut.ready,
						github,
						repository,
						branch,
						author: this.#commitAuthor(agent.name, repository),
						record: (outcome) => this.#recordPullRequest(registry, runId, outcome),
						run,
					})
				: {}),
			...edgeTools(edges, (edge, text, signal) => this.#takeEdge(run, edge, text, signal)),
		};
		const system = [agent.instructions, sandbox && repository && repositoryNote(repository, branch)]
			.filter((part) => typeof part === "string")
			.join("\n\n");
		const end = async (status: "succeeded" | "failed" | "stopped", error: string | null = null) => {
			if (error !== null) this.#failure = error;
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
				system: system === "" ? undefined : system,
				// A turn stopped during a tool call leaves the call without a result, which providers
				// refuse in a later turn.
				messages: await convertToModelMessages(this.messages, {
					tools,
					ignoreIncompleteToolCalls: true,
				}),
				tools,
				stopWhen: stepCountIs(sandbox ? MAX_SANDBOX_STEPS : MAX_STEPS),
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

	/**
	 * A turn of an agent whose engine is Claude Code: it runs in the sandbox, on the repository
	 * checked out first, with the workspace's key added to its requests on the way out. Its text and
	 * tool calls come to the chat as it works, and the run's trace records each model request and
	 * tool call. Stopping the turn stops Claude Code. It uses no MCP servers yet (the registry
	 * refuses them), nor a team's edges.
	 */
	#claudeCodeTurn(
		{
			agent,
			key,
			repository,
			runId,
		}: Pick<ConversationTurn, "agent" | "key" | "repository" | "runId">,
		run: RunRecorder,
		signal: AbortSignal | undefined,
	): Response {
		const env = this.env as unknown as RuntimeEnv;
		const { workspaceId, conversationId, registry } = this.#parties();
		const end = async (status: "succeeded" | "failed" | "stopped", error: string | null = null) => {
			if (error !== null) this.#failure = error;
			const finish = run.finish(status, error);
			if (finish) await this.#report(registry, runId, finish);
		};
		const sandbox = this.#sandbox();
		const refusal = claudeCodeRefusal(agent, key, sandbox !== null, env);
		if (refusal !== null || sandbox === null || key === null) {
			const message = refusal ?? SANDBOX_NOT_OFFERED;
			void end("failed", message);
			return failed(message);
		}
		const branch = conversationBranch(conversationId);
		const stream = createUIMessageStream({
			execute: async ({ writer }) => {
				writer.write({ type: "start" });
				if (repository) {
					const problem = await withCheckout(sandbox, repository, branch).ready();
					if (problem !== null) {
						writer.write({ type: "error", errorText: problem });
						await end("failed", problem);
						return;
					}
				}
				const turn = new ClaudeCodeTurn(writer, run, agent);
				const stop = () => {
					sandbox.stopClaudeCode().catch(() => {});
				};
				signal?.addEventListener("abort", stop, { once: true });
				try {
					const events = await sandbox.startClaudeCode({
						prompt: lastUserText(this.messages),
						history: historyOf(this.messages, agent.name),
						system: [agent.instructions, claudeCodeNote(repository, branch)]
							.filter((part) => typeof part === "string")
							.join("\n\n"),
						model: agent.model,
						cwd: repository ? SANDBOX_REPOSITORY_PATH : SANDBOX_ROOT,
						access: {
							key,
							metadata: {
								workspace: workspaceId,
								agent: agent.agentId,
								conversation: conversationId,
							},
						},
					});
					for await (const line of linesOf(events)) turn.take(line);
				} catch (error) {
					console.error("Claude Code's turn failed", failureForLogs(error));
				} finally {
					signal?.removeEventListener("abort", stop);
				}
				const outcome = turn.end();
				if (signal?.aborted) {
					await end("stopped");
				} else if (outcome.status === "failed") {
					writer.write({ type: "error", errorText: outcome.error });
					await end("failed", outcome.error);
				} else {
					await end("succeeded");
				}
				writer.write({ type: "finish" });
			},
			onError: (error) => {
				console.error("Claude Code's turn failed", failureForLogs(error));
				const message = "Claude Code could not finish.";
				void end("failed", message);
				return message;
			},
		});
		return createUIMessageStreamResponse({ stream });
	}

	/**
	 * Takes one of a team's edges: a nested turn of the agent at the other end, in a new
	 * conversation. The caller's trace gets a span for it, which the nested run points back to.
	 */
	async #takeEdge(
		run: RunRecorder,
		edge: TurnEdge,
		text: string,
		signal?: AbortSignal,
	): Promise<string> {
		const env = this.env as unknown as RuntimeEnv;
		const { workspaceId } = this.#parties();
		const span = run.edgeStarted(edge.kind, edge.name);
		let nested: NestedConversation | undefined;
		let outcome: NestedTurnOutcome;
		// The nested turn stops with the turn that waits for it.
		const stop = () => {
			nested?.stopNestedTurn().catch(() => {});
		};
		signal?.addEventListener("abort", stop, { once: true });
		try {
			const name = conversationName(workspaceId, crypto.randomUUID());
			nested = (await getAgentByName(env.CONVERSATIONS, name)) as unknown as NestedConversation;
			const { kind, team, to } = edge;
			outcome = await nested.nestedTurn({
				text,
				via: { parentRunId: run.runId, parentSpanId: span, kind, team, to },
			});
		} catch (error) {
			run.edgeEnded(span, { childRunId: null, error: "It could not be reached" });
			console.error("An edge could not be taken", { edge: edge.kind, ...failureForLogs(error) });
			throw new Error(`${edge.name} could not be reached`);
		} finally {
			signal?.removeEventListener("abort", stop);
		}
		const error = "error" in outcome ? outcome.error : null;
		run.edgeEnded(span, { childRunId: outcome.runId, error });
		if ("error" in outcome) {
			// A turn the registry refused leaves a conversation it never heard of.
			if (outcome.runId === null) await nested.destroy().catch(() => {});
			throw new Error(outcome.error);
		}
		return outcome.answer ?? `${edge.name} has the message and takes a turn of its own on it.`;
	}

	/**
	 * Where the pull requests of a sandbox's work are made: GitHub, through the deployment's GitHub
	 * App. None on a server that is not one, whose registry refuses turns with a repository anyway.
	 */
	#pullRequests(repository: SandboxRepository): PullRequestPort | null {
		const env = this.env as unknown as RuntimeEnv;
		const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = env;
		if (!appId || !privateKey) return null;
		return gitHubPullRequests(sharedApp({ appId, privateKey }), repository);
	}

	/**
	 * Who a sandbox's commits are by: the GitHub App's bot, which GitHub links to its commits, so a
	 * repository's CLA check can read them. The agent's name stays on them. Falls back to the
	 * agent's address when the app is not set up or the lookup fails, which must not fail the push.
	 */
	#commitAuthor(name: string, repository: SandboxRepository): () => Promise<CommitAuthor> {
		const env = this.env as unknown as RuntimeEnv;
		const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = env;
		const fallback = { name, email: COMMIT_EMAIL };
		if (!appId || !privateKey) return async () => fallback;
		const app = sharedApp({ appId, privateKey });
		return async () => {
			try {
				const bot = await app.botIdentity(repository.installationId);
				return { name, email: bot.email };
			} catch (error) {
				console.error("A commit's author was not looked up", failureForLogs(error));
				return fallback;
			}
		};
	}

	/** Puts the pull request on the run. A failure is logged: the pull request is made anyway. */
	async #recordPullRequest(
		registry: DurableObjectStub<RegistryDO>,
		runId: string,
		{ repository, number, url }: PullRequestOutcome,
	): Promise<void> {
		try {
			await registry.recordRunPullRequest(runId, { repository, number, url });
		} catch (error) {
			console.error("A run's pull request was not recorded", { runId, ...failureForLogs(error) });
		}
	}

	/** Deletes the conversation, and its sandbox with it. */
	override async destroy(): Promise<void> {
		try {
			await this.#sandbox()?.destroy();
		} catch (error) {
			console.error("A sandbox was not stopped", failureForLogs(error));
		}
		await super.destroy();
	}

	/**
	 * The conversation's sandbox, under its own name; none where the deployment offers none, in
	 * which case the registry refuses the turns that need one.
	 */
	#sandbox(): Sandbox | null {
		const env = this.env as unknown as RuntimeEnv;
		return (env.SANDBOX?.getByName(this.name) as unknown as Sandbox | undefined) ?? null;
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

/**
 * Why a turn of Claude Code cannot start, in words for whoever is chatting; null when it can. The
 * registry enforces the agent's side, so these are the server's: a sandbox, the workspace's key and
 * a working AI Gateway setting.
 */
function claudeCodeRefusal(
	agent: AgentSnapshot,
	key: string | null,
	sandboxed: boolean,
	settings: GatewaySettings,
): string | null {
	if (!sandboxed) return SANDBOX_NOT_OFFERED;
	if (key === null) return `${providerMissing(agent.provider)}, so no agent can answer`;
	try {
		gatewayOf(settings);
	} catch (error) {
		if (error instanceof SettingsError) return error.message;
		throw error;
	}
	return null;
}

/** The text of the latest message from the person chatting. */
function lastUserText(messages: UIMessage[]): string {
	const message = messages.findLast((candidate) => candidate.role === "user");
	return (message?.parts ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
}

/** The text of the conversation's last answer, cut to what a caller's model reads. */
function answerOf(messages: UIMessage[], name: string): string {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	const text = (message?.parts ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n\n")
		.trim();
	if (text === "") return `${name} finished without an answer.`;
	return text.length <= MAX_ANSWER
		? text
		: `${text.slice(0, MAX_ANSWER)}\n\n[${name}'s answer was cut short here.]`;
}

/** A turn that ends before the model is called, with why. */
function failed(message: string): Response {
	return createUIMessageStreamResponse({
		stream: createUIMessageStream({
			execute: ({ writer }) => writer.write({ type: "error", errorText: message }),
		}),
	});
}
