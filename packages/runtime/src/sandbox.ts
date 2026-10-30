/**
 * A conversation's sandbox: a Durable Object with a Linux container of its own, where the turns of
 * an agent with a sandbox run commands and read and write files (`./sandbox-tools.ts`). It has no
 * route; only its conversation reaches it, over RPC, under the conversation's own name.
 *
 * The container starts on the first call and stops after `IDLE_MINUTES` without one, and its disk
 * goes with it. It has no internet: every HTTP and HTTPS request it makes comes to
 * `SandboxOutbound`, which lets downloads from package registries through, git's fetches of the
 * repository the conversation checked out, and the push of the conversation's branch that `push`
 * makes, and an engine's requests to its model's provider while it runs a turn, and nothing else
 * (`./outbound.ts`). It holds no secret of the workspace's, so a command has none to leak: the
 * token for that repository, and the workspace's key for the model, are added on the way out.
 *
 * A deployment offers sandboxes by binding this class as `SANDBOX` with a container (see
 * `wrangler.jsonc`); its image is `sandbox/Dockerfile`.
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { sharedApp } from "@gateweave/agents-github";
import {
	SANDBOX_INSTANCE,
	SANDBOX_NOT_OFFERED,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import type { CheckoutResult } from "./checkout";
import { claudeCodeCommand } from "./claude-code";
import { CODEX_SESSIONS, codexCommand } from "./codex";
import { toolsRequest } from "./engine-tools";
import {
	ENGINE_SECONDS,
	type EngineCommand,
	type EngineExit,
	type EngineJob,
	type EnginePort,
	logTail,
	type RunningEngine,
	type SandboxEngine,
	TIMED_OUT_STATUS,
} from "./engines";
import {
	anthropicRequest,
	failureForLogs,
	type GatewaySettings,
	googleRequest,
	openaiRequest,
	SettingsError,
} from "./models";
import { OPENCODE_INSTRUCTIONS } from "./opencode";
import {
	OPENCODE_PORT,
	OPENCODE_SERVER_EXIT,
	OPENCODE_SERVER_LOG,
	OPENCODE_SERVER_SCRIPT,
	type OpenCodeServerPort,
	type OpenCodeServerTurn,
	startOpenCodeTurn,
} from "./opencode-server";
import {
	ANTHROPIC_API,
	checkPush,
	decideOutbound,
	ENGINE_TOOLS_HOST,
	type GitAccess,
	GOOGLE_API,
	OPENAI_API,
	type PushWindow,
	pushedRefs,
	withGitHubToken,
} from "./outbound";
import { clipOutput } from "./output";
import type { CommitAuthor, PushResult } from "./pull-requests";
import {
	type CommandResult,
	IDLE_MINUTES,
	type ReadResult,
	SANDBOX_ROOT,
	type SandboxPort,
	type WriteResult,
} from "./sandbox-tools";

/** The largest file `readFile` opens: the model reads a bigger one with a command. */
export const READ_BYTES = 5_000_000;

const IDLE_MS = IDLE_MINUTES * 60_000;

/** The certificate the container's HTTPS goes through on its way to `SandboxOutbound`. */
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/**
 * What every command runs with. A command does not take the container's start environment, so
 * the tools find the certificate this way.
 */
const COMMAND_ENV = {
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/root",
	LANG: "C.UTF-8",
	NODE_EXTRA_CA_CERTS: CA_PATH,
	GIT_SSL_CAINFO: CA_PATH,
	CURL_CA_BUNDLE: CA_PATH,
	SSL_CERT_FILE: CA_PATH,
	REQUESTS_CA_BUNDLE: CA_PATH,
	PIP_CERT: CA_PATH,
	// Git asks for nothing: a refused fetch fails at once instead of waiting for a password.
	GIT_TERMINAL_PROMPT: "0",
	NPM_CONFIG_UPDATE_NOTIFIER: "false",
};

/** How long a clone may take before the checkout gives up, and a push. */
const CLONE_SECONDS = 300;
const PUSH_SECONDS = 300;

/** The largest push the Worker reads to check its ref updates; bigger work stays unpushed. */
export const MAX_PUSH_BYTES = 50_000_000;

const REPOSITORY_KEY = "repository";
/** The commit the conversation last pushed to its branch. */
const PUSHED_KEY = "pushed";
/** The conversation's Claude Code session, which its turns resume while the container has it. */
const SESSION_KEY = "claude-code-session";
/** The conversation's OpenCode session, which its turns continue while the container has it. */
const OPENCODE_SESSION_KEY = "opencode-session";

/** How long `OPENCODE_SERVER_SCRIPT` may take, which waits up to 10 s for an old server to stop. */
const OPENCODE_SCRIPT_SECONDS = 60;

/** How a request to each provider's API goes out, with the workspace's key. */
const MODEL_REQUESTS: ReadonlyMap<string | undefined, typeof anthropicRequest> = new Map([
	["anthropic", anthropicRequest],
	["openai", openaiRequest],
	["google", googleRequest],
]);

/** The hosts whose requests depend on the engine running a turn, if any. */
const ENGINE_HOSTS = new Set([ANTHROPIC_API, OPENAI_API, GOOGLE_API, ENGINE_TOOLS_HOST]);

/** How long an engine has to finish its turn when it is stopped, before it is killed. */
const STOP_GRACE_MS = 10_000;

/** The signals that stop an engine: Ctrl+C's, which ends its turn, and a kill's. */
const SIGINT = 2;
const SIGTERM = 15;

/** `timeout`'s exit codes for a command it stopped, and one it had to kill. */
const TIMED_OUT = new Set([124, 137]);

/** How long `engineExit` waits for the engine to exit after its events end. */
const EXIT_WAIT_MS = 5_000;

/** Most bytes of the end of the engine's log that `engineExit` reads. */
const LOG_TAIL_BYTES = 4_096;

/** The environment a commit is made with: the author, as both its author and its committer. */
export function commitEnvironment(author: CommitAuthor): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_COMMITTER_NAME: author.name,
		GIT_COMMITTER_EMAIL: author.email,
	};
}

/** What `SandboxOutbound` is made with: the sandbox whose requests it decides on. */
interface OutboundProps {
	sandbox?: string;
}

/** The app's Worker exports `SandboxOutbound` beside this class. */
interface SandboxState extends DurableObjectState {
	readonly exports: Cloudflare.Exports & {
		readonly SandboxOutbound: (options?: { props?: OutboundProps }) => Fetcher;
	};
}

export class RunnerSandbox extends DurableObject implements SandboxPort, EnginePort {
	readonly #container: Container | undefined;
	readonly #outbound: Fetcher;
	/** The container's start under way, which every call waits for. */
	#starting: Promise<void> | undefined;
	/**
	 * The push `push` is making, which `SandboxOutbound` lets through. In memory alone, so it ends
	 * with this instance if the push never does.
	 */
	#push: PushWindow | null = null;
	/** The engine's turn under way, if any. */
	#engine: ExecProcess | null = null;
	/** The turn of OpenCode's server under way, if any, which runs in place of a process. */
	#openCode: OpenCodeServerTurn | null = null;
	/**
	 * What the turn the engine is running reaches through `SandboxOutbound`: the workspace's key,
	 * which goes on its requests to the model's provider, and the way to the conversation's tools.
	 * In memory alone, like `#push`, and only while the turn runs.
	 */
	#running: RunningEngine | null = null;
	/**
	 * The last turn's log, where in it the turn began for a log that every turn adds to, when it
	 * started, and how it ended, for `engineExit`.
	 */
	#lastTurn: {
		log: string;
		logFrom?: number;
		started: number;
		ended: Promise<{ code: number | null; seconds: number }>;
	} | null = null;

	constructor(ctx: SandboxState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#container = ctx.container;
		this.#outbound = ctx.exports.SandboxOutbound({ props: { sandbox: ctx.id.toString() } });
		// Each instance sets its own timeout: a container that outlived the last one keeps none.
		const container = this.#container;
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(IDLE_MS));
		}
	}

	async run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult> {
		const container = await this.#ready();
		if (cwd !== SANDBOX_ROOT) {
			const missing = await this.#directoryProblem(container, cwd);
			if (missing) return { exitCode: 1, output: missing, timedOut: false };
		}
		return this.#exec(container, ["bash", "-c", command], cwd, timeoutSeconds);
	}

	/**
	 * Checks out the repository at `SANDBOX_REPOSITORY_PATH` on a new `branch` from its default
	 * branch, or from what the conversation pushed (`#branchStart`), unless it is there already. A
	 * conversation keeps the repository it first checked out: a repository chosen later on the agent
	 * is for its next conversations.
	 */
	async checkout(repository: SandboxRepository, branch: string): Promise<CheckoutResult> {
		const kept = this.#repository();
		const name = `${repository.owner}/${repository.name}`;
		if (kept && kept.externalId !== repository.externalId) {
			return {
				error: `This conversation's sandbox has ${kept.owner}/${kept.name} checked out. Start a new conversation to work on ${name}.`,
			};
		}
		// Kept before the clone, whose requests to GitHub ask for it on their way out.
		if (!kept) this.ctx.storage.kv.put(REPOSITORY_KEY, repository);
		const container = await this.#ready();
		if (await this.#isGitCheckout(container)) return { checkedOut: false };
		const clone = await this.#exec(
			container,
			// No blobs until a checkout needs them, so a big repository clones in seconds.
			[
				"git",
				"clone",
				"--filter=blob:none",
				"--branch",
				repository.defaultBranch,
				`https://github.com/${name}.git`,
				SANDBOX_REPOSITORY_PATH,
			],
			SANDBOX_ROOT,
			CLONE_SECONDS,
		);
		// Gone, so the next tool call clones again rather than finding a checkout off the branch.
		const failed = async (error: string): Promise<CheckoutResult> => {
			await this.#exec(container, ["rm", "-rf", SANDBOX_REPOSITORY_PATH], SANDBOX_ROOT, 30);
			return { error };
		};
		if (clone.exitCode !== 0) return failed(`${name} could not be checked out.\n${clone.output}`);
		const start = await this.#branchStart(container, branch);
		if ("error" in start) return failed(start.error);
		const switched = await this.#exec(
			container,
			["git", "switch", "--create", branch, ...start.from],
			SANDBOX_REPOSITORY_PATH,
			30,
		);
		if (switched.exitCode !== 0) {
			return failed(
				`${name} is cloned, but the branch ${branch} was not made.\n${switched.output}`,
			);
		}
		return { checkedOut: true };
	}

	/**
	 * Where a new checkout's branch starts: the default branch, or, when the conversation pushed
	 * before its sandbox stopped, the branch as it is on GitHub, so the work goes on from there and
	 * the next push adds to it. A branch deleted since, such as after its pull request merged,
	 * starts over from the default branch.
	 */
	async #branchStart(
		container: Container,
		branch: string,
	): Promise<{ from: string[] } | { error: string }> {
		if (this.ctx.storage.kv.get<string>(PUSHED_KEY) === undefined) return { from: [] };
		const remote = `refs/remotes/origin/${branch}`;
		const fetched = await this.#exec(
			container,
			["git", "fetch", "--quiet", "origin", `refs/heads/${branch}:${remote}`],
			SANDBOX_REPOSITORY_PATH,
			CLONE_SECONDS,
		);
		if (fetched.exitCode === 0) return { from: [remote] };
		if (/couldn't find remote ref/i.test(fetched.output)) return { from: [] };
		return {
			error: `The work this conversation pushed to ${branch} could not be fetched.\n${fetched.output}`,
		};
	}

	/**
	 * Commits every change in the checkout with `message`, unless there are none to commit, and
	 * pushes the work to `branch`, unless the branch has it already. Refuses when the work has no
	 * commit the default branch does not. Git's push leaves through `SandboxOutbound` like every
	 * request, which lets it through while this lasts.
	 */
	async push(branch: string, message: string, author: CommitAuthor): Promise<PushResult> {
		const repository = this.#repository();
		if (!repository) return { error: "This sandbox has no repository checked out." };
		const container = await this.#ready();
		if (!(await this.#isGitCheckout(container))) {
			return {
				error: `${repository.owner}/${repository.name} is not checked out in this sandbox.`,
			};
		}
		const git = (args: string[], seconds = 60, env: Record<string, string> = {}) =>
			this.#exec(container, ["git", ...args], SANDBOX_REPOSITORY_PATH, seconds, env);
		const added = await git(["add", "--all"]);
		if (added.exitCode !== 0) return { error: `The changes could not be added.\n${added.output}` };
		// Exits 1 when something is staged.
		const staged = await git(["diff", "--cached", "--quiet"]);
		if (staged.exitCode === 1) {
			// The repository's own hooks run, as they would for a person.
			const committed = await git(
				["commit", "--quiet", "--message", message],
				120,
				commitEnvironment(author),
			);
			if (committed.exitCode !== 0) {
				return { error: `The changes could not be committed.\n${committed.output}` };
			}
		} else if (staged.exitCode !== 0) {
			return { error: `The changes could not be read.\n${staged.output}` };
		}
		const base = `origin/${repository.defaultBranch}`;
		const ahead = await git(["rev-list", "--count", `${base}..HEAD`]);
		if (ahead.exitCode !== 0) {
			return { error: `The work could not be compared with ${base}.\n${ahead.output}` };
		}
		if (Number.parseInt(ahead.output.trim(), 10) === 0) {
			return {
				error: `There is nothing to propose: the work has no commit that ${repository.defaultBranch} does not.`,
			};
		}
		const head = (await git(["rev-parse", "HEAD"])).output.trim();
		const pushed = this.ctx.storage.kv.get<string>(PUSHED_KEY) ?? null;
		if (head === pushed) return { head, pushed: false };
		this.#push = { branch, from: pushed };
		let result: CommandResult;
		try {
			result = await git(
				["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`],
				PUSH_SECONDS,
			);
		} finally {
			this.#push = null;
		}
		if (result.exitCode !== 0) {
			if (/\[rejected\]|non-fast-forward|fetch first/.test(result.output)) {
				return {
					error: `Someone else pushed to ${branch} since this conversation did, and their commits are not in the work, so it was not pushed over them.\n${result.output}`,
				};
			}
			return { error: `${branch} could not be pushed.\n${result.output}` };
		}
		this.ctx.storage.kv.put(PUSHED_KEY, head);
		return { head, pushed: true };
	}

	/**
	 * What `SandboxOutbound` lets git reach: the repository the conversation checked out, to fetch,
	 * and the push `push` is making, if any.
	 */
	access(): (GitAccess & { repository: SandboxRepository }) | null {
		const repository = this.#repository();
		return repository ? { repository, push: this.#push } : null;
	}

	async readFile(path: string): Promise<ReadResult> {
		const files = new Files(await this.#ready());
		try {
			const stat = await files.stat(path);
			if (stat.type === "directory") {
				return { error: `${path} is a directory. List it with find_files or run_command.` };
			}
			if (stat.size > BigInt(READ_BYTES)) {
				return {
					error: `${path} is ${stat.size} bytes, more than read_file opens (${READ_BYTES}). Look into it with run_command, such as head, sed -n or rg.`,
				};
			}
			const content = await (await files.readFile(path)).text();
			if (content.includes("\u0000")) return { error: `${path} is not a text file.` };
			return { content };
		} catch (error) {
			return { error: describeFileFailure(error, path) };
		}
	}

	async writeFile(path: string, content: string): Promise<WriteResult> {
		const files = new Files(await this.#ready());
		try {
			const directory = path.slice(0, path.lastIndexOf("/"));
			if (directory !== "") await files.mkdir(directory, { recursive: true });
			await files.writeFile(path, content);
			return { written: new TextEncoder().encode(content).length };
		} catch (error) {
			return { error: describeFileFailure(error, path) };
		}
	}

	/**
	 * Starts a turn of the job's engine in `job.cwd`, resuming the conversation's session when the
	 * container still has it, or starting one. Returns its events as it writes them; the stream ends
	 * with the turn, which may run for `ENGINE_SECONDS`, and the container stays up meanwhile.
	 */
	async startEngine(job: EngineJob): Promise<ReadableStream<Uint8Array>> {
		if (this.#engine || this.#openCode) {
			throw new Error("An engine is already running a turn in this sandbox");
		}
		this.#lastTurn = null;
		const container = await this.#ready();
		if (job.engine === "opencode") return this.#startOpenCode(container, job);
		const command = await this.#commandFor(container, job, job.engine);
		this.#running = { engine: job.engine, provider: job.provider, access: job.access };
		await container.setInactivityTimeout(ENGINE_SECONDS * 1000 + IDLE_MS);
		let process: ExecProcess;
		try {
			process = await container.exec(
				[
					"timeout",
					"--kill-after=30s",
					`${ENGINE_SECONDS}s`,
					"bash",
					"-c",
					// Its own messages go to a file, this turn's alone, so its output holds only its events.
					`exec "$0" "$@" 2>${command.log}`,
					...command.argv,
				],
				{
					cwd: job.cwd,
					env: { ...COMMAND_ENV, ...command.env },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "ignore",
				},
			);
		} catch (error) {
			await this.#engineEnded(container);
			throw error;
		}
		this.#engine = process;
		const started = Date.now();
		const seconds = () => (Date.now() - started) / 1000;
		this.#lastTurn = {
			log: command.log,
			started,
			ended: process.exitCode.then(
				(code) => ({ code, seconds: seconds() }),
				() => ({ code: null, seconds: seconds() }),
			),
		};
		process.exitCode
			.catch(() => null)
			.then(() => this.#engineEnded(container))
			.catch((error: unknown) =>
				console.error("A sandbox did not settle after its engine", failureForLogs(error)),
			);
		// The message goes on its input, which has no limit on its length as an argument does.
		const input = process.stdin?.getWriter();
		if (input) {
			await input.write(new TextEncoder().encode(command.input));
			await input.close();
		}
		if (!process.stdout) throw new Error("The engine's output could not be read");
		return process.stdout as ReadableStream<Uint8Array>;
	}

	async stopEngine(): Promise<void> {
		if (this.#openCode) return this.#openCode.stop();
		const process = this.#engine;
		if (!process) return;
		process.kill(SIGINT);
		setTimeout(() => {
			if (this.#engine === process) process.kill(SIGTERM);
		}, STOP_GRACE_MS);
	}

	async engineExit(): Promise<EngineExit | null> {
		const turn = this.#lastTurn;
		const container = this.#container;
		if (!turn || !container) return null;
		// Its events can end a moment before it exits.
		const ended = await Promise.race([
			turn.ended,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), EXIT_WAIT_MS)),
		]);
		let log = "";
		if (container.running) {
			const tail =
				turn.logFrom === undefined
					? ["tail", "--bytes", String(LOG_TAIL_BYTES), turn.log]
					: [
							"bash",
							"-c",
							'tail --bytes="+$(($1 + 1))" "$2" | tail --bytes "$3"',
							"tail",
							String(turn.logFrom),
							turn.log,
							String(LOG_TAIL_BYTES),
						];
			const read = await this.#exec(container, tail, SANDBOX_ROOT, 10).catch(() => null);
			if (read?.exitCode === 0) log = logTail(read.output);
		}
		return {
			code: ended?.code ?? null,
			seconds: ended?.seconds ?? (Date.now() - turn.started) / 1000,
			log,
		};
	}

	/** The engine whose turn `SandboxOutbound` lets out, and with what; null when none runs. */
	runningEngine(): RunningEngine | null {
		return this.#running;
	}

	async #engineEnded(container: Container): Promise<void> {
		this.#engine = null;
		this.#running = null;
		if (container.running) await container.setInactivityTimeout(IDLE_MS);
	}

	/**
	 * Starts a turn of OpenCode on its server in the container, which the turn starts, or starts
	 * over, unless it runs with the turn's settings (`./opencode-server.ts`). The server stays up
	 * for the next turn. Its events end with the turn, which the sandbox stops at `ENGINE_SECONDS`.
	 */
	async #startOpenCode(container: Container, job: EngineJob): Promise<ReadableStream<Uint8Array>> {
		// Before the server is reached: reconnecting its MCP server goes out as the turn's request.
		this.#running = { engine: job.engine, provider: job.provider, access: job.access };
		await container.setInactivityTimeout(ENGINE_SECONDS * 1000 + IDLE_MS);
		let turn: OpenCodeServerTurn;
		try {
			if (job.system !== "") {
				await new Files(container).writeFile(OPENCODE_INSTRUCTIONS, job.system);
			}
			turn = await startOpenCodeTurn(
				this.#openCodeServer(container),
				job,
				this.ctx.storage.kv.get<string>(OPENCODE_SESSION_KEY),
			);
		} catch (error) {
			await this.#engineEnded(container);
			throw error;
		}
		if (turn.session !== null) this.ctx.storage.kv.put(OPENCODE_SESSION_KEY, turn.session);
		this.#openCode = turn;
		const started = Date.now();
		let timedOut = false;
		const limit = setTimeout(() => {
			timedOut = true;
			void turn.stop();
		}, ENGINE_SECONDS * 1000);
		this.#lastTurn = {
			log: OPENCODE_SERVER_LOG,
			logFrom: turn.logFrom,
			started,
			ended: turn.ended.then(async () => ({
				code: timedOut ? TIMED_OUT_STATUS : await this.#openCodeExit(container),
				seconds: (Date.now() - started) / 1000,
			})),
		};
		turn.ended
			.then(() => {
				clearTimeout(limit);
				if (this.#openCode === turn) this.#openCode = null;
				return this.#engineEnded(container);
			})
			.catch((error: unknown) =>
				console.error("A sandbox did not settle after OpenCode's turn", failureForLogs(error)),
			);
		return turn.events;
	}

	/** The container's OpenCode server, as a turn reaches it. */
	#openCodeServer(container: Container): OpenCodeServerPort {
		return {
			ensure: async (env) => {
				const started = await this.#exec(
					container,
					["bash", "-c", OPENCODE_SERVER_SCRIPT],
					SANDBOX_ROOT,
					OPENCODE_SCRIPT_SECONDS,
					{ ...env, OPENCODE_SETTINGS: JSON.stringify(env) },
				);
				const said = /^(running|started) (\d+)$/m.exec(started.output);
				if (started.exitCode !== 0 || !said) {
					throw new Error(`OpenCode's server did not start: ${started.output.slice(-500)}`);
				}
				return { logFrom: Number(said[2]) };
			},
			fetch: (path, init) =>
				container.getTcpPort(OPENCODE_PORT).fetch(`http://opencode.internal${path}`, init),
		};
	}

	/** The exit status of the container's OpenCode server, if it has exited. */
	async #openCodeExit(container: Container): Promise<number | null> {
		if (!container.running) return null;
		const read = await this.#exec(container, ["cat", OPENCODE_SERVER_EXIT], SANDBOX_ROOT, 10).catch(
			() => null,
		);
		const code = read?.exitCode === 0 ? Number.parseInt(read.output, 10) : Number.NaN;
		return Number.isNaN(code) ? null : code;
	}

	/** The command for the job's turn, in the session the container has, or a new one. */
	async #commandFor(
		container: Container,
		job: EngineJob,
		engine: Exclude<SandboxEngine, "opencode">,
	): Promise<EngineCommand> {
		switch (engine) {
			case "claude-code": {
				let session = this.ctx.storage.kv.get<string>(SESSION_KEY);
				const resume =
					session !== undefined && (await this.#hasClaudeCodeSession(container, session));
				if (!resume || session === undefined) {
					session = crypto.randomUUID();
					this.ctx.storage.kv.put(SESSION_KEY, session);
				}
				return claudeCodeCommand(job, session, resume);
			}
			case "codex": {
				// The container holds this conversation's sessions alone, so its last is the one.
				const found = await this.#exec(
					container,
					["find", CODEX_SESSIONS, "-name", "rollout-*.jsonl", "-print", "-quit"],
					SANDBOX_ROOT,
					30,
				);
				return codexCommand(job, found.exitCode === 0 && found.output.trim() !== "");
			}
		}
	}

	/** Whether the container has the session's transcript, which Claude Code keeps in its home. */
	async #hasClaudeCodeSession(container: Container, session: string): Promise<boolean> {
		const found = await this.#exec(
			container,
			["find", "/root/.claude/projects", "-name", `${session}.jsonl`, "-print", "-quit"],
			SANDBOX_ROOT,
			30,
		);
		return found.exitCode === 0 && found.output.trim() !== "";
	}

	/** Stops the container, and its files go with it. The conversation calls it as it is deleted. */
	async destroy(): Promise<void> {
		if (this.#container?.running) await this.#container.destroy();
	}

	#repository(): SandboxRepository | null {
		return this.ctx.storage.kv.get<SandboxRepository>(REPOSITORY_KEY) ?? null;
	}

	/** Whether the repository is checked out already: the container has run since the clone. */
	async #isGitCheckout(container: Container): Promise<boolean> {
		try {
			await new Files(container).stat(`${SANDBOX_REPOSITORY_PATH}/.git`);
			return true;
		} catch (error) {
			if (SandboxFileError.is(error) && error.code === "ENOENT") return false;
			throw error;
		}
	}

	/** Runs `argv` under GNU `timeout`, with its output clipped as it streams. */
	async #exec(
		container: Container,
		argv: string[],
		cwd: string,
		timeoutSeconds: number,
		env: Record<string, string> = {},
	): Promise<CommandResult> {
		const process = await container.exec(
			["timeout", "--kill-after=5s", `${timeoutSeconds}s`, ...argv],
			{ cwd, env: { ...COMMAND_ENV, ...env }, stdout: "pipe", stderr: "combined" },
		);
		const [output, exitCode] = await Promise.all([clipOutput(process.stdout), process.exitCode]);
		return { exitCode, output: output.text, timedOut: TIMED_OUT.has(exitCode) };
	}

	async #ready(): Promise<Container> {
		const container = this.#container;
		if (!container) throw new Error(SANDBOX_NOT_OFFERED);
		if (!this.#starting && !container.running) {
			this.#starting = this.#start(container).finally(() => {
				this.#starting = undefined;
			});
		}
		await this.#starting;
		return container;
	}

	async #start(container: Container): Promise<void> {
		try {
			container.start({
				image: container.images.sandbox ?? "",
				// Budgets price sandbox time by this machine (`SANDBOX_SECOND_PRICE`).
				instance: SANDBOX_INSTANCE,
				enableInternet: false,
			});
			// The intercepts last as long as this run of the container. The tools' host is named too,
			// so that the container's network answers lookups of a name that exists nowhere else.
			await container.interceptOutboundHttp(ENGINE_TOOLS_HOST, this.#outbound);
			await container.interceptAllOutboundHttp(this.#outbound);
			await container.interceptOutboundHttps("*", this.#outbound);
			await container.setInactivityTimeout(IDLE_MS);
		} catch (error) {
			console.error("A sandbox did not start", failureForLogs(error));
			if (container.running) await container.destroy().catch(() => {});
			throw new Error("The sandbox could not start. Try again in a few minutes.");
		}
	}

	async #directoryProblem(container: Container, path: string): Promise<string | null> {
		try {
			const stat = await new Files(container).stat(path);
			return stat.type === "directory" ? null : `${path} is not a directory.`;
		} catch (error) {
			return describeFileFailure(error, path);
		}
	}
}

/**
 * The settings `SandboxOutbound` reads: the sandboxes, the deployment's GitHub App, and its AI
 * Gateway, which an engine's requests to the model go through as Gateweave's own do.
 */
interface OutboundEnv extends GatewaySettings {
	SANDBOX?: DurableObjectNamespace<RunnerSandbox>;
	CONVERSATIONS: DurableObjectNamespace;
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
}

/** What `SandboxOutbound` reaches of a conversation: the tools of the turn an engine runs. */
interface ToolsConversation {
	engineTools(token: string, request: Request): Promise<Response>;
}

/**
 * Where the container's HTTP and HTTPS requests come out: those `decideOutbound` allows go on from
 * the Worker, and the rest get a 403 whose text says why, which the command prints. A fetch of the
 * conversation's repository goes out with a token minted for that repository alone, to read it,
 * and the push `RunnerSandbox.push` makes with one that writes, once its ref updates are checked.
 * While an engine runs a turn, its requests to the model go out with the workspace's key, and
 * those to Gateweave's tools never go out: the conversation answers them, with the turn's token.
 */
export class SandboxOutbound extends WorkerEntrypoint<Cloudflare.Env, OutboundProps> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const access = url.hostname === "github.com" ? await this.#access() : null;
		const running = ENGINE_HOSTS.has(url.hostname) ? await this.#runningEngine() : null;
		const tools = running?.access.tools ?? null;
		const decision = decideOutbound(
			request.method,
			url,
			access,
			running?.provider ?? null,
			tools !== null,
		);
		if (!decision.allow) return refused(decision.reason, 403);
		const env = this.env as unknown as OutboundEnv;
		const toModel = MODEL_REQUESTS.get(decision.credentials);
		if (toModel && running) {
			const { key, metadata } = running.access;
			try {
				return await fetch(toModel(request, key, env, metadata));
			} catch (error) {
				if (error instanceof SettingsError) return refused(error.message, 502);
				throw error;
			}
		}
		if (decision.credentials === "tools" && tools) {
			const conversation = env.CONVERSATIONS.getByName(tools.conversation);
			return (conversation as unknown as ToolsConversation).engineTools(
				tools.token,
				toolsRequest(request),
			);
		}
		let outgoing = request;
		if (decision.push) {
			// Git sends a push as it is. One encoded otherwise could hide its ref updates.
			if (request.headers.has("content-encoding")) {
				return refused("This sandbox sends a push only as git makes it", 403);
			}
			const body = await readAtMost(request, MAX_PUSH_BYTES);
			if (body === null) {
				return refused(
					`The push is bigger than ${MAX_PUSH_BYTES / 1_000_000} MB, more than this sandbox sends. Keep large files out of the work.`,
					413,
				);
			}
			const problem = checkPush(pushedRefs(body), decision.push);
			if (problem) return refused(problem, 403);
			const headers = new Headers(request.headers);
			headers.delete("content-length");
			headers.delete("transfer-encoding");
			outgoing = new Request(request, { headers, body });
		}
		if ((decision.credentials === "read" || decision.credentials === "write") && access) {
			const token = await this.#token(access.repository, decision.credentials);
			if (token === null) {
				const reason = `GitHub gave this sandbox no token to ${decision.credentials} the repository with`;
				return refused(reason, 502);
			}
			outgoing = withGitHubToken(outgoing, token);
		}
		// A redirect is the client's to follow, so that each address it leads to is asked about too.
		return fetch(outgoing, { redirect: "manual" });
	}

	async #access() {
		const env = this.env as unknown as OutboundEnv;
		const { sandbox } = this.ctx.props;
		if (!env.SANDBOX || !sandbox) return null;
		return env.SANDBOX.get(env.SANDBOX.idFromString(sandbox)).access();
	}

	async #runningEngine(): Promise<RunningEngine | null> {
		const env = this.env as unknown as OutboundEnv;
		const { sandbox } = this.ctx.props;
		if (!env.SANDBOX || !sandbox) return null;
		return env.SANDBOX.get(env.SANDBOX.idFromString(sandbox)).runningEngine();
	}

	async #token(repository: SandboxRepository, use: "read" | "write"): Promise<string | null> {
		const env = this.env as unknown as OutboundEnv;
		const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = env;
		if (!appId || !privateKey) return null;
		try {
			return await sharedApp({ appId, privateKey }).repositoryToken(
				repository.installationId,
				repository.externalId,
				{ contents: use },
			);
		} catch (error) {
			console.error("A sandbox's GitHub token was not minted", failureForLogs(error));
			return null;
		}
	}
}

function refused(reason: string, status: number): Response {
	return new Response(`${reason}\n`, { status });
}

/** The request's body, or null when it is longer than `max` bytes. */
async function readAtMost(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > max) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > max) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	}
	const body = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.length;
	}
	return body;
}

/** A file operation's failure in words the model reads. */
function describeFileFailure(error: unknown, path: string): string {
	if (!SandboxFileError.is(error)) {
		console.error("A sandbox file operation failed", failureForLogs(error));
		return `${path} could not be reached.`;
	}
	switch (error.code) {
		case "ENOENT":
			return `${path} does not exist.`;
		case "EISDIR":
			return `${path} is a directory.`;
		case "ENOTDIR":
			return `A part of ${path} is a file, not a directory.`;
		case "EACCES":
		case "EPERM":
			return `${path} cannot be reached: permission denied.`;
		case "ENOSPC":
			return "The sandbox's disk is full.";
		default:
			return `${path}: ${error.code}`;
	}
}
