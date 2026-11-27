/**
 * Sandboxes for the tests, which have no containers: files in memory, and commands that are only
 * recorded. `MemorySandbox` stands behind the tools directly; `FakeSandbox` is the Durable Object
 * the test Worker binds as `SANDBOX`, so a conversation reaches it as it would a real one. An
 * engine writes what a test scripted for it.
 */
import { DurableObject, env } from "cloudflare:workers";
import {
	type ChangesPartData,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import type { ChangesPort } from "../src/changes";
import type { CheckoutPort, CheckoutResult } from "../src/checkout";
import type { Comparison } from "../src/checks";
import { DisposalGuard } from "../src/disposal";
import type { EngineExit, EngineJob, EnginePort } from "../src/engines";
import {
	assertForgotten,
	forgetKept,
	type KeptStorage,
	markForgotten,
	PUSHED_KEY,
	REPOSITORY_KEY,
	readKept,
	replaceKept,
} from "../src/kept-keys";
import type { LocalCommand, LocalServerPort } from "../src/local-servers";
import { type EngineMeter, meterModelRequest } from "../src/meter";
import type { ProofRun } from "../src/proof-scripts";
import type {
	CheckPort,
	CommitAuthor,
	CommitResult,
	PushPort,
	PushResult,
} from "../src/pull-requests";
import type { CommandResult, ReadResult, WriteResult } from "../src/sandbox-tools";

export interface RanCommand {
	command: string;
	cwd: string;
	timeoutSeconds: number;
	captureOutput?: boolean;
}

export interface Checkout {
	repository: SandboxRepository;
	branch: string;
	/** Set for a review's checkout: the pull request's head, detached. */
	review?: { number: number; head: string };
}

export interface Push {
	branch: string;
	message: string;
	author: CommitAuthor;
	model: string;
}

/** A commit `open_pull_request` asked for before the repository's checks. */
export interface Commit {
	message: string;
	author: CommitAuthor;
	model: string;
}

/** The push of one commit, which `open_pull_request` asks for after the repository's checks. */
export interface CommitPush {
	branch: string;
	head: string;
}

/** What the fake sandbox's git answers for a review's `merge-base` and `diff`, unless scripted. */
export const REVIEW_MERGE_BASE = "b".repeat(40);
export const REVIEW_DIFF = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1 +1 @@
-old
+new
`;

/** The heads of pull requests that GitHub has dropped: a review's checkout of one is `gone`. */
export const goneHeads = new Set<string>();

/** What a command answers; with `seconds`, how long it took by the sandbox's clock. */
export type CommandAnswer = (CommandResult & { seconds?: number }) | Error;

export class MemorySandbox implements CheckoutPort, PushPort, CheckPort, ChangesPort {
	readonly files = new Map<string, string>();
	readonly commands: RanCommand[] = [];
	readonly gitCalls: string[][] = [];
	/** Files `createFile` made that a `git clean` has not removed yet, as `git status` lists them. */
	readonly untracked = new Set<string>();
	/** What `createFile` made, in order, whether or not a `git clean` removed it since. */
	readonly created: { path: string; content: string }[] = [];
	/** How many processes the next proofs leave running, in order; then none (null: not confirmed). */
	readonly left: (number | null)[] = [];
	/** What `discardCheckout` was called with, in order; `discardError` makes it throw. */
	discards = 0;
	discardError: Error | undefined;
	/**
	 * The real disposal guard over a container that fails to destroy while `discardError` is set, so
	 * a failed disposal leaves the fake unusable, as it does the real sandbox, until one succeeds.
	 */
	readonly #marks = new Map<string, unknown>();
	readonly #disposal = new DisposalGuard({
		get: (key) => this.#marks.get(key),
		put: (key, value) => void this.#marks.set(key, value),
		delete: (key) => void this.#marks.delete(key),
	});
	readonly #container = {
		running: true,
		destroy: async () => {
			if (this.discardError) throw this.discardError;
		},
	};
	/** Why `createFile` refuses, for a test of a path that exists or goes through a symlink. */
	createError: string | undefined;
	gitAnswer: ((args: string[]) => CommandAnswer | undefined) | undefined;
	readonly checkouts: Checkout[] = [];
	/**
	 * What the next commands answer, in order; then each exits 0 and prints its command line. An
	 * error is thrown, as a sandbox that could not run the command throws.
	 */
	readonly answers: CommandAnswer[] = [];
	/** What the next checkouts answer, in order; then each checks out. */
	readonly checkoutAnswers: CheckoutResult[] = [];
	readonly pushes: Push[] = [];
	/** What the next pushes answer, in order; then each pushes a new commit. */
	readonly pushAnswers: PushResult[] = [];
	readonly commits: Commit[] = [];
	/** What the next commits answer, in order; then each makes a new commit. */
	readonly commitAnswers: CommitResult[] = [];
	/** The trees the next `changesBase` calls answer, in order; then each answers null. */
	readonly baseTrees: (string | null)[] = [];
	/** What the next `turnChanges` calls answer, in order; then each answers null. */
	readonly turnChangesAnswers: (ChangesPartData | null)[] = [];
	readonly commitPushes: CommitPush[] = [];
	/**
	 * How the checkout compares with its commit the next times it is asked; then, and for a
	 * null, it is the commit. An error is thrown, as a sandbox that cannot say throws.
	 */
	readonly changes: (Comparison | Error)[] = [];
	/** A clock for the tests that time commands: each command moves it by its `seconds`. */
	clock = 1_000_000;
	/** What was asked of it that changes or runs something, in order. */
	readonly log: string[] = [];

	async run(
		command: string,
		cwd: string,
		timeoutSeconds: number,
		captureOutput?: boolean,
	): Promise<CommandResult> {
		await this.#usable();
		this.commands.push({
			command,
			cwd,
			timeoutSeconds,
			...(captureOutput ? { captureOutput } : {}),
		});
		this.log.push(`run ${command}`);
		const answer = this.answers.shift();
		if (answer instanceof Error) throw answer;
		if (!answer) return { exitCode: 0, output: `ran: ${command}`, timedOut: false };
		const { seconds = 0, ...result } = answer;
		this.clock += seconds * 1000;
		return result;
	}

	/** A proof's command: recorded and answered as `run`, with the processes it left running. */
	async runProof(command: string, seconds: number): Promise<ProofRun> {
		const result = await this.run(command, SANDBOX_REPOSITORY_PATH, seconds);
		return { ...result, left: this.left.length ? (this.left.shift() ?? null) : 0 };
	}

	async discardCheckout(): Promise<void> {
		this.log.push("discard");
		this.discards++;
		await this.#disposal.discard(this.#container);
	}

	/** The container's own refusal, as the real sandbox has it: nothing is handed out while it stands. */
	async #usable(): Promise<void> {
		await this.#disposal.assertReusable(this.#container);
	}

	async commit(message: string, author: CommitAuthor, model: string): Promise<CommitResult> {
		this.commits.push({ message, author, model });
		this.log.push("commit");
		const head = String(this.commits.length).repeat(40).slice(0, 40);
		return this.commitAnswers.shift() ?? { head };
	}

	async git(
		args: string[],
		_seconds?: number,
		_env?: Record<string, string>,
		_outputLimit?: number,
	): Promise<CommandResult> {
		await this.#usable();
		this.log.push(`git ${args.join(" ")}`);
		this.gitCalls.push(args);
		// A scripted answer comes first: a clean that fails removes nothing, and a test that wants a
		// partial clean scripts that state itself.
		const answer = this.gitAnswer?.(args);
		if (answer instanceof Error) throw answer;
		if (args[0] === "clean" && (!answer || answer.exitCode === 0)) {
			for (const path of this.untracked) this.files.delete(`${SANDBOX_REPOSITORY_PATH}/${path}`);
			this.untracked.clear();
		}
		if (answer) return answer;
		const listed = args[0] === "status" && args.includes("-z");
		return {
			exitCode: 0,
			output: listed ? [...this.untracked].map((path) => `?? ${path}\0`).join("") : "",
			timedOut: false,
		};
	}

	async changedSince(head: string): Promise<Comparison> {
		await this.#usable();
		this.log.push(`compare ${head.slice(0, 7)}`);
		const answer = this.changes.shift() ?? null;
		if (answer instanceof Error) throw answer;
		return answer;
	}

	async changesBase(): Promise<string | null> {
		this.log.push("changes base");
		return this.baseTrees.shift() ?? null;
	}

	async turnChanges(base: string): Promise<ChangesPartData | null> {
		this.log.push(`changes since ${base.slice(0, 7)}`);
		return this.turnChangesAnswers.shift() ?? null;
	}

	async pushCommit(branch: string, head: string): Promise<PushResult> {
		this.commitPushes.push({ branch, head });
		this.log.push(`push ${head.slice(0, 7)}`);
		return this.pushAnswers.shift() ?? { head, pushed: true };
	}

	async readFile(path: string): Promise<ReadResult> {
		const content = this.files.get(path);
		return content === undefined ? { error: `${path} does not exist.` } : { content };
	}

	async writeFile(path: string, content: string): Promise<WriteResult> {
		this.files.set(path, content);
		return { written: new TextEncoder().encode(content).length };
	}

	/** Creates a file that is new, as `createProofFile` does; `createError` refuses it. */
	async createFile(path: string, content: string): Promise<WriteResult> {
		await this.#usable();
		this.log.push(`create ${path}`);
		if (this.createError) return { error: this.createError };
		if (this.files.has(path)) return { error: `${path} already exists` };
		this.files.set(path, content);
		this.created.push({ path, content });
		this.untracked.add(path.slice(`${SANDBOX_REPOSITORY_PATH}/`.length));
		return { written: new TextEncoder().encode(content).length };
	}

	async checkout(
		repository: SandboxRepository,
		branch: string,
		review?: { number: number; head: string },
	): Promise<CheckoutResult> {
		this.checkouts.push({ repository, branch, ...(review ? { review } : {}) });
		return this.checkoutAnswers.shift() ?? { checkedOut: true };
	}

	async push(
		branch: string,
		message: string,
		author: CommitAuthor,
		model: string,
	): Promise<PushResult> {
		this.pushes.push({ branch, message, author, model });
		this.log.push("commit and push");
		const head = String(this.pushes.length).repeat(40).slice(0, 40);
		return this.pushAnswers.shift() ?? { head, pushed: true };
	}
}

/**
 * A request the engine makes for the model, and the provider's answer to it, which goes through
 * the same metering as a request that leaves a real sandbox (`../src/meter.ts`).
 */
export interface ScriptedAnswer {
	answer: { status?: number; contentType?: string; body: string; headers?: Record<string, string> };
	/**
	 * How long after the answer's end the Worker reports it, for a turn whose CLI ends first. The
	 * script goes on at once.
	 */
	lateMs?: number;
}

/**
 * What a turn of an engine writes, with the model requests it makes between its lines, whether it
 * then waits until it is stopped, and how its CLI ended, as `engineExit` says it.
 */
export interface EngineScript {
	lines: (string | ScriptedAnswer)[];
	untilStopped?: boolean;
	exit?: EngineExit;
}

/**
 * A local MCP server as the fake sandbox runs it: it answers MCP's methods one line at a time,
 * offers one tool, `echo`, that answers with what it was given and the environment's `GREETING`,
 * and writes a line that is not JSON-RPC first, as some servers log on starting. The command
 * `missing` exits at once, as a command that is not installed does.
 */
function localServer(
	command: LocalCommand,
	input: ReadableStream<Uint8Array>,
	record: { heard: string[]; exited: boolean },
): ReadableStream<Uint8Array> {
	const { heard } = record;
	const { readable, writable } = new IdentityTransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const write = (message: object) => writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
	void (async () => {
		if (command.command === "missing") {
			await input.cancel();
			record.exited = true;
			await closed(writer);
			return;
		}
		await writer.write(encoder.encode("Starting the echo server…\n"));
		const decoder = new TextDecoder();
		let buffered = "";
		const reader = input.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let end = buffered.indexOf("\n");
			while (end !== -1) {
				const message = JSON.parse(buffered.slice(0, end)) as {
					id?: number;
					method: string;
					params?: { arguments?: { text?: string } };
				};
				buffered = buffered.slice(end + 1);
				end = buffered.indexOf("\n");
				heard.push(message.method);
				if (message.id === undefined) continue;
				const result = (value: unknown) => write({ jsonrpc: "2.0", id: message.id, result: value });
				if (message.method === "initialize") {
					await result({
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "echo", version: "1.0.0" },
					});
				} else if (message.method === "tools/list") {
					await result({
						tools: [
							{
								name: "echo",
								description: "Says it back",
								inputSchema: { type: "object", properties: { text: { type: "string" } } },
							},
						],
					});
				} else if (message.method === "tools/call") {
					const text = `${command.env.GREETING ?? "Hello"}: ${message.params?.arguments?.text ?? ""}`;
					await result({ content: [{ type: "text", text }] });
				} else {
					await write({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Method not found" },
					});
				}
			}
		}
		// Its input ended, as the turn closed it: it exits.
		record.exited = true;
		await closed(writer);
	})();
	return readable;
}

/**
 * Closes a fake command's output. The conversation may have stopped reading it already, as the
 * real sandbox's caller does when a turn ends, and the close then fails, as a real one would.
 */
async function closed(writer: { close(): Promise<void> }): Promise<void> {
	await writer.close().catch(() => {});
}

export class FakeSandbox
	extends DurableObject
	implements CheckoutPort, PushPort, CheckPort, EnginePort, LocalServerPort
{
	readonly #memory = new MemorySandbox();
	#destroyed = false;
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#memory.gitAnswer = (args) =>
			args[0] === "merge-base"
				? { exitCode: 0, output: REVIEW_MERGE_BASE, timedOut: false }
				: args.includes("diff")
					? { exitCode: 0, output: REVIEW_DIFF, timedOut: false }
					: undefined;
	}
	/** What the fake sandbox keeps of its conversation, as the real one's `storage.kv` does (AGT-156). */
	readonly #kept = new Map<string, unknown>();
	readonly #jobs: EngineJob[] = [];
	readonly #scripts: EngineScript[] = [];
	/** Ends the turn of the engine that waits to be stopped. */
	#release: (() => void) | null = null;
	#stops = 0;
	#exit: EngineExit | null = null;
	/** The message the next `forgetKeys` fails with, once, as a container that would not stop can. */
	#forgetFailure: string | null = null;

	run(command: string, cwd: string, timeoutSeconds: number, captureOutput?: boolean) {
		return this.#memory.run(command, cwd, timeoutSeconds, captureOutput);
	}

	readFile(path: string) {
		return this.#memory.readFile(path);
	}

	writeFile(path: string, content: string) {
		return this.#memory.writeFile(path, content);
	}

	createFile(path: string, content: string) {
		return this.#memory.createFile(path, content);
	}

	runProof(command: string, seconds: number) {
		return this.#memory.runProof(command, seconds);
	}

	discardCheckout() {
		return this.#memory.discardCheckout();
	}

	checkout(
		repository: SandboxRepository,
		branch: string,
		review?: { number: number; head: string },
	) {
		// As the real sandbox: the repository it cloned is what it keeps of the conversation.
		this.#kept.set(REPOSITORY_KEY, repository);
		if (review && goneHeads.has(review.head)) {
			return Promise.resolve({
				error: `The head ${review.head.slice(0, 7)} is gone`,
				gone: true as const,
			});
		}
		return this.#memory.checkout(repository, branch, review);
	}

	/** What the next checkouts answer, in order: for a test whose review head is gone. */
	answerCheckouts(answers: CheckoutResult[]): void {
		this.#memory.checkoutAnswers.push(...answers);
	}

	push(branch: string, message: string, author: CommitAuthor, model: string) {
		this.#kept.set(PUSHED_KEY, `pushed:${branch}`);
		return this.#memory.push(branch, message, author, model);
	}

	commit(message: string, author: CommitAuthor, model: string) {
		return this.#memory.commit(message, author, model);
	}

	git(args: string[], seconds?: number, env?: Record<string, string>, outputLimit?: number) {
		return this.#memory.git(args, seconds, env, outputLimit);
	}

	answerGit(answers: { match: string[]; answer: CommandResult }[]) {
		this.#memory.gitAnswer = (args) =>
			answers.find(({ match }) => match.every((word, i) => word === args[i]))?.answer;
	}

	changedSince(head: string) {
		return this.#memory.changedSince(head);
	}

	changesBase() {
		return this.#memory.changesBase();
	}

	turnChanges(base: string) {
		return this.#memory.turnChanges(base);
	}

	/** What the next `changesBase` and `turnChanges` calls answer, in order. */
	answerTurnChanges(baseTrees: (string | null)[], changes: (ChangesPartData | null)[]): void {
		this.#memory.baseTrees.push(...baseTrees);
		this.#memory.turnChangesAnswers.push(...changes);
	}

	pushCommit(branch: string, head: string) {
		return this.#memory.pushCommit(branch, head);
	}

	/** How the checkout compares with its commit the next times it is asked. */
	answerChanges(changes: Comparison[]): void {
		this.#memory.changes.push(...changes);
	}

	/** What the next commands answer, in order: for a test that fails the repository's checks. */
	answerCommands(answers: CommandResult[]): void {
		this.#memory.answers.push(...answers);
	}

	/** The local MCP servers started, with the methods each heard, and whether each has exited. */
	readonly #servers: { command: LocalCommand; heard: string[]; exited: boolean }[] = [];

	async startMcpServer(
		command: LocalCommand,
		input: ReadableStream<Uint8Array>,
	): Promise<ReadableStream<Uint8Array>> {
		const started = { command, heard: [] as string[], exited: false };
		this.#servers.push(started);
		return localServer(command, input, started);
	}

	/** What the next turn of an engine writes; one without a script writes nothing. */
	scriptEngine(script: EngineScript): void {
		this.#scripts.push(script);
	}

	async startEngine(job: EngineJob): Promise<ReadableStream<Uint8Array>> {
		this.#jobs.push(job);
		const { lines, untilStopped = false, exit = null } = this.#scripts.shift() ?? { lines: [] };
		this.#exit = exit;
		const { readable, writable } = new IdentityTransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		void (async () => {
			for (const line of lines) {
				if (typeof line === "string") await writer.write(encoder.encode(`${line}\n`));
				else await this.#answer(job, line);
			}
			if (untilStopped) await new Promise<void>((resolve) => (this.#release = resolve));
			await writer.close();
		})();
		return readable;
	}

	/** Makes a request for the model, which the CLI reads to its end, and waits for its record. */
	async #answer(job: EngineJob, { answer, lateMs }: ScriptedAnswer): Promise<void> {
		const conversation = (env as unknown as { CONVERSATIONS: DurableObjectNamespace })
			.CONVERSATIONS;
		const stub = conversation.getByName(job.access.meter.conversation) as unknown as EngineMeter;
		const meter: EngineMeter = {
			engineRequestPause: (token) => stub.engineRequestPause(token),
			engineRequestStarted: (token) => stub.engineRequestStarted(token),
			engineRequestEnded: async (token, step, request) => {
				if (lateMs) await new Promise((resolve) => setTimeout(resolve, lateMs));
				return stub.engineRequestEnded(token, step, request);
			},
		};
		const recorded: Promise<unknown>[] = [];
		const response = await meterModelRequest(
			meter,
			job.access.meter.token,
			job.provider,
			async () =>
				new Response(answer.body, {
					status: answer.status ?? 200,
					headers: { "content-type": answer.contentType ?? "text/event-stream", ...answer.headers },
				}),
			(promise) => recorded.push(promise),
		);
		await response.text();
		if (lateMs) {
			this.ctx.waitUntil(Promise.all(recorded));
			return;
		}
		await Promise.all(recorded);
	}

	async engineExit(): Promise<EngineExit | null> {
		return this.#exit;
	}

	async stopEngine(): Promise<void> {
		this.#stops += 1;
		this.#release?.();
		this.#release = null;
	}

	destroy(): void {
		this.#destroyed = true;
	}

	moveKeys(): [string, unknown][] {
		return readKept(new KeptMap(this.#kept));
	}

	takeKeys(entries: [string, unknown][]): void {
		replaceKept(new KeptMap(this.#kept), entries);
	}

	markForForget(): void {
		markForgotten(new KeptMap(this.#kept));
	}

	/** Makes the next `forgetKeys` fail once. */
	failForgetKeys(message: string): void {
		this.#forgetFailure = message;
	}

	forgetKeys(): void {
		if (this.#forgetFailure !== null) {
			const failure = this.#forgetFailure;
			this.#forgetFailure = null;
			throw new Error(failure);
		}
		// As the real sandbox's `forgetKeys`: an unmarked one stops and keeps nothing-to-wipe
		// refuses before anything of it is touched (AGT-156).
		assertForgotten(new KeptMap(this.#kept));
		this.destroy();
		forgetKept(new KeptMap(this.#kept));
	}

	/** The arguments of each `git` the sandbox ran for a tool, in order. */
	gitCalls(): string[][] {
		return this.#memory.gitCalls;
	}

	/**
	 * What the tests check: files, commands, checkouts, pushes, local MCP servers, and whether
	 * the conversation destroyed it.
	 */
	seen() {
		return {
			files: Object.fromEntries(this.#memory.files),
			commands: this.#memory.commands,
			checkouts: this.#memory.checkouts,
			pushes: this.#memory.pushes,
			commits: this.#memory.commits,
			commitPushes: this.#memory.commitPushes,
			engine: this.#jobs,
			stops: this.#stops,
			destroyed: this.#destroyed,
			// What the sandbox keeps of its conversation, as `readKept` sees it: the erasure mark
			// is in the same store but is no kept key. The RPC types cannot carry `unknown`: the
			// stub's `seen()` would type as `never`.
			kept: Object.fromEntries(readKept(new KeptMap(this.#kept))) as Record<string, never>,
			mcpServers: this.#servers,
		};
	}
}

/** A `Map` as the kept keys' `KeptStorage`, so the fake shares the real one's rules (AGT-156). */
class KeptMap implements KeptStorage {
	constructor(private readonly entries: Map<string, unknown>) {}
	get(key: string): unknown {
		return this.entries.get(key);
	}
	put(key: string, value: unknown): void {
		this.entries.set(key, value);
	}
	delete(key: string): void {
		this.entries.delete(key);
	}
}
