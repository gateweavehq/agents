import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { sharedApp } from "@gateweave/agents-github";
import {
	type AgentSnapshot,
	conversationBranch,
	ENGINE_NAMES,
	PULL_REQUEST_TOOL,
	type PullRequestOutcome,
	providerMissing,
	type RunSpan,
	SANDBOX_NOT_OFFERED,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
	SESSION_ENDED,
	type TriggerTurnOutcome,
	type TurnEdge,
	type TurnVia,
	type WorkersAiSettings,
} from "@gateweave/agents-model";
import {
	type BackupRow,
	beginImport,
	type ConversationTurn,
	checkCopy,
	digestForMove,
	endImport,
	freezeEnds,
	freezeForMove,
	MOVING_MESSAGE,
	type MoveCursor,
	type MoveKeys,
	type MoveManifest,
	type MoveOut,
	type MovePage,
	type MoveRows,
	mayImport,
	moveStateAtStart,
	moveStateNow,
	objectsIn,
	type RegistryDO,
	readForBackup,
	readForMove,
	readKeysForMove,
	sealForMove,
	type Thawed,
	thaw,
	thawAfterMove,
	writeForMove,
	writeKeysForMove,
} from "@gateweave/agents-registry";
import { type Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	stepCountIs,
	streamText,
	type ToolSet,
	type UIMessage,
} from "ai";
import { type ChatSession, sessionOpening } from "./chat-session";
import { type CheckoutPort, repositoryNote, withCheckout } from "./checkout";
import { ClaudeCodeTurn } from "./claude-code";
import { CodexTurn } from "./codex";
import { edgeTools } from "./edges";
import { serveEngineTools } from "./engine-tools";
import {
	type ChunkSink,
	type EnginePort,
	type EngineTurn,
	engineNote,
	historyOf,
	linesOf,
	type SandboxEngine,
	settle,
} from "./engines";
import type { LocalServerPort } from "./local-servers";
import { RegistryOAuthProvider } from "./mcp-oauth";
import { type MeteredRequest, meteredRequest } from "./meter";
import {
	describeFailure,
	failureForLogs,
	type GatewaySettings,
	gatewayOf,
	languageModel,
	SettingsError,
} from "./models";
import { OpenCodeTurn } from "./opencode";
import {
	COMMIT_EMAIL,
	type CommitAuthor,
	gitHubPullRequests,
	type PullRequestPort,
	type PushPort,
	pullRequestTools,
} from "./pull-requests";
import { createRunMessages, recordRunMessage, replayHistory, runMessageOf } from "./replay";
import { SANDBOX_ROOT, sandboxTools } from "./sandbox-tools";
import { createOutbox, queueExport, sendDue } from "./telemetry-export";
import { connectTools, type OAuthProviders } from "./tools";
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
interface Sandbox extends CheckoutPort, PushPort, EnginePort, LocalServerPort {
	destroy(): Promise<void>;
}

const SEPARATOR = ":";

/** The longest a turn of an engine waits for its last requests' ends to be recorded. */
const METERED_WAIT_MS = 5_000;

/** A request whose report did not check out: it is recorded as failed, with nothing used. */
const UNREAD_REQUEST: MeteredRequest = {
	model: null,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	finishReason: "error",
	firstTokenMs: null,
	gatewayLogId: null,
	error: null,
};

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

/**
 * Why a conversation that took in a moving one restarts, as an error its caller may see in place
 * of the answer. It means the move into it ended.
 */
export const MOVED_IN = "moved in";

/** The name of a conversation's Durable Object: its workspace and its id. */
export function conversationName(workspaceId: string, conversationId: string): string {
	return `${workspaceId}${SEPARATOR}${conversationId}`;
}

/**
 * Destroys a conversation's object, for a caller outside it. The SDK empties the object's storage
 * and then aborts it, and on Cloudflare the abort can reach the caller before the answer, as an
 * error saying `destroyed`. That means it worked, so only another error is one.
 */
export async function destroyConversationObject(conversation: {
	destroy(): Promise<void>;
}): Promise<void> {
	try {
		await conversation.destroy();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message !== "destroyed") throw error;
	}
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
 * An agent whose engine is a vendor's coding agent, such as Claude Code, takes its turns
 * differently: the vendor's CLI runs in the sandbox with its own tools, and the turn passes on what
 * it does (`./engines.ts`). The rest of the turn's tools reach it as an MCP server that this
 * conversation answers (`./engine-tools.ts`).
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
	/** The export of run traces under way, so two never send the same run at once. */
	#exporting: Promise<void> | null = null;
	/** The turn `nestedTurn` or `triggerTurn` began, which the next `onChatMessage` takes up. */
	#begun: ConversationTurn | null = null;
	/** Stops the nested turn under way, when the turn waiting for it stops. */
	#stopNested: AbortController | null = null;
	/** Why the turn under way failed, in the app's words; null while it has not. */
	#failure: string | null = null;
	/**
	 * The turn an engine is running, which its sandbox reaches with the token: its tools, if it has
	 * any, and its run, where its requests for the model are recorded as they leave the sandbox,
	 * with the steps of those still under way.
	 */
	#engineTurnState: {
		token: string;
		tools: ToolSet | null;
		signal: AbortSignal;
		run: RunRecorder;
		requests: Set<number>;
	} | null = null;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		// A move doesn't outlive a restart: its freeze ends here (`move.ts` in the registry package).
		moveStateAtStart(ctx.storage);
		// AIChatAgent takes chat messages in the onMessage its constructor sets, so the session is
		// checked in front of that, for every message a socket sends.
		const take = this.onMessage;
		this.onMessage = async (connection, message) => {
			if (await this.#sessionEnded(connection)) return;
			return take(connection, message);
		};
	}

	/**
	 * A socket opens only through the app's gateway, which checked the session and says which it
	 * was. The gateway is not asked again, so the socket keeps the session, to stop taking messages
	 * once it ends rather than go on with someone's authority after they signed out.
	 */
	override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
		const session = sessionOpening(ctx.request);
		if (!session) {
			connection.close(SESSION_ENDED, "Session ended");
			return;
		}
		connection.setState({ session });
		return super.onConnect(connection, ctx);
	}

	/**
	 * Whether the session a socket opened with still holds, for this workspace. Here, until it runs
	 * out; the app also asks its database, where signing out, revoking it and the provider's logout
	 * delete it, and leaving the workspace ends the membership.
	 */
	protected async sessionHolds(session: ChatSession, _workspaceId: string): Promise<boolean> {
		return session.expiresAt > Date.now();
	}

	async #sessionEnded(connection: Connection): Promise<boolean> {
		const session = (connection.state as { session?: ChatSession } | null)?.session;
		if (session && (await this.sessionHolds(session, this.#parties().workspaceId))) return false;
		connection.close(SESSION_ENDED, "Session ended");
		return true;
	}

	override async onStart(): Promise<void> {
		// A conversation moving away, gone away or half copied in keeps its runs as they are.
		if (moveStateNow(this.ctx.storage, Date.now()) !== null) return;
		// A restart cut these runs short: they will not end on their own.
		const interrupted = closeInterruptedRuns(this.#sql);
		if (interrupted.length === 0) return;
		const { registry } = this.#parties();
		await Promise.all(
			interrupted.map(({ runId, finish }) => this.#report(registry, runId, finish)),
		);
	}

	/**
	 * Sockets and requests get nowhere while a move has the conversation, or once it moved away:
	 * they come back to wherever the app sends them by then.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (this.#away()) {
			return new Response(MOVING_MESSAGE, { status: 503, headers: { "retry-after": "30" } });
		}
		return super.fetch(request);
	}

	/** The SDK's alarm, which waits for a move under way and never runs once the conversation moved. */
	override async alarm(): Promise<void> {
		const moving = moveStateNow(this.ctx.storage, Date.now());
		if (moving === "sealed" || moving === "importing") return;
		if (moving === "frozen") {
			// One that died lets the freeze lapse, and the work resumes then.
			const until = freezeEnds(this.ctx.storage);
			if (until !== null) await this.ctx.storage.setAlarm(until);
			return;
		}
		thaw(this.ctx.storage);
		return super.alarm();
	}

	/** Whether a move has the conversation now. A freeze that lapsed ends here. */
	#away(): boolean {
		const moving = moveStateNow(this.ctx.storage, Date.now());
		if (moving !== null) return true;
		thaw(this.ctx.storage);
		return false;
	}

	// RPC for moving the workspace's objects somewhere else (`move.ts` in the registry package),
	// which the app does from its daily run. Nothing else calls these.

	/**
	 * Freezes the conversation for a move to `to` and says what it holds, or that it moved before.
	 * Its sockets close, and tabs reconnect to wherever the app sends them by then.
	 */
	async moveOut(token: string, to: string): Promise<MoveOut> {
		const out = await freezeForMove(this.ctx.storage, token, to, Date.now());
		if (!out.frozen) return out;
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1012, "Conversation moving");
			} catch {
				// Already closing.
			}
		}
		// The alarm's work waits for the move. If the move dies, the alarm ends the freeze.
		const until = freezeEnds(this.ctx.storage);
		if (until !== null) await this.ctx.storage.setAlarm(until);
		return out;
	}

	/** The next page of the frozen conversation's rows. */
	moveRead(token: string, cursor: MoveCursor, chars?: number): MovePage {
		return readForMove(this.ctx.storage, token, cursor, Date.now(), chars);
	}

	/** The next page of the frozen conversation's key-value pairs, the SDK's among them. */
	moveReadKeys(token: string, after: string | null): MoveKeys {
		return readKeysForMove(this.ctx.storage, token, after, Date.now());
	}

	/**
	 * Seals the conversation, whose copy holds it from now on. Its tables take writes again, so
	 * that the SDK can still start it, to be destroyed; nothing reaches it to write.
	 */
	async moveSeal(token: string | null, to: string): Promise<void> {
		await sealForMove(this.ctx.storage, token, to, Date.now(), { keepBlocks: false });
	}

	/** Ends the freeze of a move that gave up, so the conversation works where it is. */
	async moveThaw(token: string): Promise<Thawed> {
		const thawed = thawAfterMove(this.ctx.storage, token);
		// Its alarm was moved to the freeze's end; the SDK plans the next from its queue.
		if (thawed === "thawed") await this.ctx.storage.setAlarm(Date.now());
		return thawed;
	}

	/** Empties this conversation, if it holds none, to take the rows of a move. */
	async moveIn(token: string, manifest: MoveManifest): Promise<void> {
		const tables = new Set(
			this.ctx.storage.sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map((row) => row.name),
		);
		const fresh = ["cf_ai_chat_agent_messages", "trace_runs"].every(
			(table) =>
				!tables.has(table) ||
				this.ctx.storage.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length === 0,
		);
		if (!mayImport(this.ctx.storage, fresh)) {
			throw new Error("This conversation holds one, so it can't take another's rows.");
		}
		await beginImport(this.ctx.storage, token, manifest);
	}

	/** Writes a page of the moving conversation's rows. */
	moveWrite(token: string, page: MoveRows[]): void {
		writeForMove(this.ctx.storage, token, page);
	}

	/** Writes a page of the moving conversation's key-value pairs. */
	moveWriteKeys(token: string, entries: [string, unknown][]): void {
		writeKeysForMove(this.ctx.storage, token, entries);
	}

	/** Checks the copy against what the conversation held. */
	moveCheck(token: string, manifest: MoveManifest): void {
		checkCopy(this.ctx.storage, token, manifest);
	}

	/** A hash of each table's rows and of the key-value pairs, for a move's two ends to compare. */
	moveDigest(): Promise<Record<string, string>> {
		return digestForMove(this.ctx.storage);
	}

	/**
	 * Ends a move into this conversation, which holds it from now on, then restarts it: what the SDK
	 * read into memory as it started was of the empty object this was. The restart can reach the
	 * caller before the answer, as an error saying {@link MOVED_IN}.
	 */
	async moveStart(from: string): Promise<void> {
		await endImport(this.ctx.storage, from, Date.now());
		setTimeout(() => this.ctx.abort(MOVED_IN), 0);
	}

	/**
	 * Reads for Gateweave Backup, run together and rolled back (the registry's `backup.ts`). The
	 * app's Backup entrypoint calls it only for a conversation the registry lists.
	 */
	backupRead(statements: unknown): BackupRow[][] {
		return readForBackup(this.ctx.storage, statements);
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

	/**
	 * This conversation's messages up to a run's model request `step`, as JSON, for a replay of the
	 * run in a conversation of its own (`./replay.ts`). Null when the run is not this conversation's,
	 * or began before runs remembered their message. The app checks first that the caller may.
	 */
	replaySource(runId: string, step: number): string | null {
		if (typeof runId !== "string" || !Number.isInteger(step) || step < 0) return null;
		const messageId = runMessageOf(this.#sql, runId);
		if (messageId === null) return null;
		const history = replayHistory(this.messages, messageId, step);
		return history ? JSON.stringify(history) : null;
	}

	/**
	 * Takes the first turn of a replay: this new conversation gets `history`, the JSON of the replayed
	 * conversation's messages up to the step (`replaySource`), and the agent answers from there. The
	 * registry begins the run, which it links to the run replayed. Nobody waits for the answer.
	 */
	async replayTurn(history: string): Promise<TriggerTurnOutcome> {
		const { conversationId, registry } = this.#parties();
		if (this.messages.length > 0) {
			return { runId: null, error: "This conversation has begun already" };
		}
		const messages = JSON.parse(history) as UIMessage[];
		const turn = await registry.beginTurn(conversationId, lastUserText(messages));
		if ("status" in turn) return { runId: null, error: turn.message };
		this.#begun = turn;
		const done = this.saveMessages(() => messages);
		this.keepAliveWhile(() => done).catch((error: unknown) =>
			console.error("A replay's turn failed", failureForLogs(error)),
		);
		return { runId: turn.runId };
	}

	/** Stops the nested turn under way. */
	stopNestedTurn(): void {
		this.#stopNested?.abort();
	}

	/**
	 * Takes the one turn a trigger's delivery opened this conversation for, with the trigger's
	 * message. The registry checks the conversation and begins the run. Nobody waits for the
	 * answer, so the conversation stays awake until the turn ends.
	 *
	 * `runs` is where the app shows the workspace's runs, such as `https://…/acme/runs/`. The run
	 * has a page only once it began, so the agent is told it after the trigger's message, to link
	 * where it reports, such as an issue it comments on.
	 */
	async triggerTurn(text: string, runs: string | null = null): Promise<TriggerTurnOutcome> {
		const { conversationId, registry } = this.#parties();
		const turn = await registry.beginTriggerTurn(conversationId, text);
		if ("status" in turn) return { runId: null, error: turn.message };
		this.#begun = turn;
		const told =
			typeof runs === "string"
				? `${text}

${runPageNote(runs, turn.runId)}`
				: text;
		const message: UIMessage = {
			id: crypto.randomUUID(),
			role: "user",
			parts: [{ type: "text", text: told }],
		};
		const done = this.saveMessages((messages) => [...messages, message]);
		this.keepAliveWhile(() => done).catch((error: unknown) =>
			console.error("A trigger's turn failed", failureForLogs(error)),
		);
		return { runId: turn.runId };
	}

	/**
	 * Answers an engine's requests to Gateweave's tools, which `SandboxOutbound` hands on from the
	 * conversation's sandbox while a turn runs. A request without the turn's token finds nothing,
	 * as does any once the turn has ended.
	 */
	async engineTools(token: string, request: Request): Promise<Response> {
		const turn = this.#engineTurnFor(token);
		if (!turn?.tools) return new Response(null, { status: 404 });
		return serveEngineTools(turn.tools, request, turn.signal);
	}

	/**
	 * A request of the engine's for the model left the sandbox (`SandboxOutbound`, `./meter.ts`):
	 * its span starts. Returns its step, or null without the turn's token or once the turn ended.
	 */
	engineRequestStarted(token: string): number | null {
		const turn = this.#engineTurnFor(token);
		if (!turn) return null;
		const step = turn.run.meteredStarted();
		turn.requests.add(step);
		return step;
	}

	/** A request `engineRequestStarted` began has ended, with what its answer reported. */
	engineRequestEnded(token: string, step: number, request: MeteredRequest): void {
		const turn = this.#engineTurnFor(token);
		if (!turn?.requests.has(step)) return;
		const checked = meteredRequest.safeParse(request);
		turn.requests.delete(step);
		turn.run.meteredEnded(
			step,
			checked.success
				? checked.data
				: { ...UNREAD_REQUEST, error: "What the answer reported could not be read." },
		);
	}

	#engineTurnFor(token: string) {
		const turn = this.#engineTurnState;
		return turn && typeof token === "string" && token === turn.token ? turn : null;
	}

	/**
	 * Waits, a while at most, for the turn's requests that left the sandbox to be recorded: the
	 * engine can end its turn a moment before the Worker reports its last request's end.
	 */
	async #meteredRequests(requests: Set<number>): Promise<void> {
		const until = Date.now() + METERED_WAIT_MS;
		while (requests.size > 0 && Date.now() < until) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
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
		recordRunMessage(this.#sql, runId, this.messages);
		const sandbox = turn.sandbox ? this.#sandbox() : null;
		const branch = conversationBranch(conversationId);
		const run = new RunRecorder(this.#sql, runId, agent);
		if (agent.engine !== "gateweave") {
			return this.#engineTurn(agent.engine, turn, run, options?.abortSignal);
		}
		const toolbox = await connectTools(
			mcpServers,
			run,
			options?.abortSignal,
			sandbox,
			this.#oauth(registry),
		);
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
	 * A turn of an agent whose engine runs in the sandbox, on the repository checked out first, with
	 * the workspace's key added to its requests on the way out. Its text and tool calls come to the
	 * chat as it works, and the run's trace records its model requests and tool calls. The turn's
	 * other tools, its MCP servers, `open_pull_request` and a team's edges, are the same as in
	 * Gateweave's loop, and reach the CLI through `engineTools`. Stopping the turn stops the CLI and
	 * the calls under way.
	 */
	#engineTurn(
		engine: SandboxEngine,
		{
			agent,
			key,
			mcpServers,
			edges,
			repository,
			runId,
			sandbox: sandboxed,
		}: Pick<
			ConversationTurn,
			"agent" | "key" | "mcpServers" | "edges" | "repository" | "runId" | "sandbox"
		>,
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
		const sandbox = sandboxed ? this.#sandbox() : null;
		const refusal = engineRefusal(agent, key, sandbox !== null, env);
		if (refusal !== null || sandbox === null || key === null) {
			const message = refusal ?? SANDBOX_NOT_OFFERED;
			void end("failed", message);
			return failed(message);
		}
		const branch = conversationBranch(conversationId);
		const stream = createUIMessageStream({
			execute: async ({ writer }) => {
				writer.write({ type: "start" });
				const checkedOut = repository ? withCheckout(sandbox, repository, branch) : null;
				const [problem, toolbox] = await Promise.all([
					checkedOut ? checkedOut.ready() : null,
					connectTools(mcpServers, run, signal, sandbox, this.#oauth(registry)),
				]);
				if (problem) {
					await toolbox.close();
					writer.write({ type: "error", errorText: problem });
					await end("failed", problem);
					return;
				}
				const github = repository ? this.#pullRequests(repository) : null;
				const tools: ToolSet = {
					...toolbox.tools,
					...(checkedOut && repository && github
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
					...edgeTools(edges, (edge, text, edgeSignal) =>
						this.#takeEdge(run, edge, text, edgeSignal),
					),
				};
				const offered = Object.keys(tools).length > 0;
				const token = crypto.randomUUID();
				const calls = new AbortController();
				const requests = new Set<number>();
				this.#engineTurnState = {
					token,
					tools: offered ? tools : null,
					signal: calls.signal,
					run,
					requests,
				};
				const turn = engineTurn(engine, writer, run, agent);
				const stop = () => {
					calls.abort();
					sandbox.stopEngine().catch(() => {});
				};
				signal?.addEventListener("abort", stop, { once: true });
				try {
					const note = engineNote(repository, branch, PULL_REQUEST_TOOL in tools);
					const events = await sandbox.startEngine({
						engine,
						prompt: lastUserText(this.messages),
						history: historyOf(this.messages, agent.name),
						system: [agent.instructions, note]
							.filter((part) => typeof part === "string")
							.join("\n\n"),
						provider: agent.provider,
						model: agent.model,
						cwd: repository ? SANDBOX_REPOSITORY_PATH : SANDBOX_ROOT,
						access: {
							key,
							metadata: {
								workspace: workspaceId,
								agent: agent.agentId,
								conversation: conversationId,
							},
							tools: offered ? { conversation: this.name, token } : null,
							meter: { conversation: this.name, token },
						},
					});
					for await (const line of linesOf(events)) turn.take(line);
				} catch (error) {
					console.error(`${ENGINE_NAMES[engine]}'s turn failed`, failureForLogs(error));
				} finally {
					signal?.removeEventListener("abort", stop);
					await this.#meteredRequests(requests);
					if (this.#engineTurnState?.token === token) this.#engineTurnState = null;
					calls.abort();
					await toolbox.close();
				}
				const ended = turn.end();
				if (signal?.aborted) {
					await end("stopped");
				} else {
					const outcome = await settle(ended, ENGINE_NAMES[engine], sandbox);
					if (outcome.status === "failed") {
						writer.write({ type: "error", errorText: outcome.error });
						await end("failed", outcome.error);
					} else {
						await end("succeeded");
					}
				}
				writer.write({ type: "finish" });
			},
			onError: (error) => {
				console.error(`${ENGINE_NAMES[engine]}'s turn failed`, failureForLogs(error));
				const message = `${ENGINE_NAMES[engine]} could not finish.`;
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
			const here = objectsIn(env.CONVERSATIONS, this.ctx.id.jurisdiction);
			nested = (await getAgentByName(here, name)) as unknown as NestedConversation;
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
		const sandboxes = env.SANDBOX && objectsIn(env.SANDBOX, this.ctx.id.jurisdiction);
		return (sandboxes?.getByName(this.name) as unknown as Sandbox | undefined) ?? null;
	}

	/** The conversation's SQLite, with the trace's tables made on first use. */
	get #sql(): Sql {
		const sql = this.sql.bind(this) as Sql;
		if (!this.#traceTables) {
			createTraceTables(sql);
			createOutbox(sql);
			createRunMessages(sql);
			this.#traceTables = true;
		}
		return sql;
	}

	/**
	 * The OAuth clients of the turn's servers connected through OAuth (AGT-78): their tokens live
	 * in the registry, sealed, and are refreshed there.
	 */
	#oauth(registry: DurableObjectStub<RegistryDO>): OAuthProviders {
		return (assetId) => new RegistryOAuthProvider(registry, assetId, {});
	}

	/** The workspace and conversation this is, from its name, and the workspace's registry. */
	#parties() {
		const env = this.env as unknown as RuntimeEnv;
		const [workspaceId = "", conversationId = ""] = this.name.split(SEPARATOR);
		// The workspace's objects are all where this one is (`move.ts` in the registry package).
		const registry = objectsIn(env.REGISTRY, this.ctx.id.jurisdiction).getByName(workspaceId);
		return { workspaceId, conversationId, registry };
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
		queueExport(this.#sql, runId);
		this.ctx.waitUntil(this.exportTraces());
	}

	/**
	 * Sends the traces of the runs that ended to the workspace's OpenTelemetry endpoint, if it has
	 * one, and wakes again when a failed one is due to be tried again (`./telemetry-export.ts`).
	 * Never throws: the export is a copy.
	 */
	async exportTraces(): Promise<void> {
		this.#exporting ??= (async () => {
			try {
				const { workspaceId, registry } = this.#parties();
				const next = await sendDue(this.#sql, registry, workspaceId);
				if (next !== null) await this.schedule(new Date(next), "exportTraces");
			} catch (error) {
				console.error("Run traces were not exported", failureForLogs(error));
			} finally {
				this.#exporting = null;
			}
		})();
		return this.#exporting;
	}

	/** Only the server changes the state, and this agent keeps none. */
	override validateStateChange(_state: unknown, source: unknown): void {
		if (source !== "server") throw new Error("This conversation's state is not changed here");
	}
}

/** Follows a turn of the engine. */
function engineTurn(
	engine: SandboxEngine,
	sink: ChunkSink,
	run: RunRecorder,
	agent: AgentSnapshot,
): EngineTurn {
	switch (engine) {
		case "claude-code":
			return new ClaudeCodeTurn(sink, run, agent);
		case "codex":
			return new CodexTurn(sink, run, agent);
		case "opencode":
			return new OpenCodeTurn(sink, run, agent);
	}
}

/**
 * Why a turn of an engine cannot start, in words for whoever is chatting; null when it can. The
 * registry enforces the agent's side, so these are the server's: a sandbox, the workspace's key and
 * a working AI Gateway setting.
 */
function engineRefusal(
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

/**
 * Where a trigger's run can be followed, said to the agent after the trigger's message. The app
 * passes `runs`; anything that is not an http(s) address of a sensible length is left out, so the
 * message never carries what it should not.
 */
function runPageNote(runs: string, runId: string): string {
	const page = runs.length <= 2000 && /^https?:\/\/[^\s]+\/$/.test(runs) ? `${runs}${runId}` : null;
	return page === null
		? `This run is ${runId} in Gateweave Agents.`
		: `This run's page, where people can follow your work in Gateweave Agents: ${page}`;
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
