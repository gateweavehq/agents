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
	type ChangesPartData,
	SANDBOX_INSTANCE,
	SANDBOX_NOT_OFFERED,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
	type SandboxSettings,
	sandboxIdleMinutes,
} from "@gateweave/agents-model";
import { objectsIn } from "@gateweave/agents-registry";
import { turnChanges as diffChanges, changesBase as writeChangesBase } from "./changes";
import type { CheckoutResult } from "./checkout";
import type { Comparison } from "./checks";
import { claudeCodeCommand } from "./claude-code";
import { CODEX_SESSIONS, codexCommand } from "./codex";
import { DisposalGuard } from "./disposal";
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
import { changedSince, commitWork, type Git, isCommitId, pushArguments } from "./git-work";
import {
	assertForgotten,
	forgetKept,
	isForgotten,
	markForgotten,
	OPENCODE_SESSION_KEY,
	PUSHED_KEY,
	REPOSITORY_KEY,
	readKept,
	replaceKept,
	SESSION_KEY,
} from "./kept-keys";
import type { LocalCommand, LocalServerPort } from "./local-servers";
import type { EngineMeter } from "./meter";
import { readAtMost, sendModelRequest } from "./model-requests";
import { failureForLogs, type GatewaySettings } from "./models";
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
import { boundedSearchOutput, clipCommandOutput, clipOutput, readPrefix } from "./output";
import { createProofFile, type ProofRun, RUN_PROOF_SCRIPT, readProofRun } from "./proof-scripts";
import type { CommitAuthor, CommitResult, PushResult } from "./pull-requests";
import type { ReviewPort } from "./review";
import {
	type CommandResult,
	type ReadResult,
	SANDBOX_ROOT,
	type SandboxPort,
	type WriteResult,
} from "./sandbox-tools";

/** Where local MCP servers' own messages go, for whoever looks into the sandbox. */
const MCP_SERVER_LOG = "/tmp/gateweave-mcp-servers.log";

/** The largest file `readFile` opens: the model reads a bigger one with a command. */
export const READ_BYTES = 5_000_000;

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
	// pnpm and Yarn come through Corepack (sandbox/Dockerfile). It downloads the version a
	// repository names without asking, from npm, which the sandbox reaches (Yarn 2 and later
	// would otherwise come from repo.yarnpkg.com, which it does not), and never writes
	// `packageManager` into the repository, where it would end up in a pull request.
	COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
	COREPACK_NPM_REGISTRY: "https://registry.npmjs.org",
	COREPACK_ENABLE_AUTO_PIN: "0",
};

/** How long a clone may take before the checkout gives up, and a push. */
const CLONE_SECONDS = 300;
const PUSH_SECONDS = 300;

/** The largest push the Worker reads to check its ref updates; bigger work stays unpushed. */
export const MAX_PUSH_BYTES = 50_000_000;

/** How long `OPENCODE_SERVER_SCRIPT` may take, which waits up to 10 s for an old server to stop. */
const OPENCODE_SCRIPT_SECONDS = 60;

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

export { commitEnvironment } from "./git-work";

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

export class RunnerSandbox
	extends DurableObject
	implements SandboxPort, EnginePort, LocalServerPort, ReviewPort
{
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
	/** Milliseconds the container may sit without a request before it stops (`SANDBOX_IDLE_MINUTES`). */
	#idleMs: number;
	/** Whether a destroy of the container is owed after a review proof left it unusable. */
	readonly #disposal: DisposalGuard;

	constructor(ctx: SandboxState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#idleMs = sandboxIdleMinutes(env as SandboxSettings) * 60_000;
		this.#disposal = new DisposalGuard(ctx.storage.kv);
		this.#container = ctx.container;
		this.#outbound = ctx.exports.SandboxOutbound({ props: { sandbox: ctx.id.toString() } });
		// Each instance sets its own timeout: a container that outlived the last one keeps none.
		const container = this.#container;
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(this.#idleMs));
		}
	}

	async run(
		command: string,
		cwd: string,
		timeoutSeconds: number,
		captureOutput = false,
		outputMode?: "search",
	): Promise<CommandResult> {
		const container = await this.#ready();
		if (cwd !== SANDBOX_ROOT) {
			const missing = await this.#directoryProblem(container, cwd);
			if (missing) return { exitCode: 1, output: missing, timedOut: false, notStarted: true };
		}
		if (captureOutput) return this.#runCaptured(container, command, cwd, timeoutSeconds);
		return this.#exec(
			container,
			["bash", "-c", command],
			cwd,
			timeoutSeconds,
			{},
			undefined,
			false,
			outputMode,
		);
	}

	/** Stream one command into a private sandbox file; offer the path only after tee finishes. */
	async #runCaptured(
		container: Container,
		command: string,
		cwd: string,
		timeoutSeconds: number,
	): Promise<CommandResult> {
		const files = new Files(container);
		let directory: string | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			const candidate = `${SANDBOX_ROOT}/.gateweave-command-${crypto.randomUUID()}`;
			try {
				await files.mkdir(candidate);
				directory = candidate;
				break;
			} catch (error) {
				if (!(SandboxFileError.is(error) && error.code === "EEXIST")) break;
			}
		}
		if (!directory)
			return this.#exec(
				container,
				["bash", "-c", command],
				cwd,
				timeoutSeconds,
				{},
				undefined,
				true,
			);
		const path = `${directory}/output.log`;
		const marker = `${directory}/complete`;
		let retain = false;
		try {
			// The command and paths are argv, never inserted into the shell source.
			const script = `timeout --kill-after=5s "$1" bash -c "$2" 2>&1 | tee --output-error=warn-nopipe -- "$3" 2>/dev/null; codes=("\${PIPESTATUS[@]}"); if [ "\${codes[1]}" -eq 0 ]; then : > "$4"; fi; exit "\${codes[0]}"`;
			const process = await container.exec(
				["bash", "-c", script, "bash", `${timeoutSeconds}s`, command, path, marker],
				{ cwd, env: COMMAND_ENV, stdout: "pipe", stderr: "combined" },
			);
			const [preview, exitCode] = await Promise.all([
				clipCommandOutput(process.stdout),
				process.exitCode,
			]);
			const result: CommandResult = {
				exitCode,
				output: preview.text,
				timedOut: TIMED_OUT.has(exitCode),
			};
			if (preview.omitted > 0) {
				try {
					const [completed, log] = await Promise.all([files.lstat(marker), files.lstat(path)]);
					if (
						completed.type === "file" &&
						completed.size === 0n &&
						log.type === "file" &&
						log.size === BigInt(preview.totalBytes)
					) {
						result.outputPath = path;
						retain = true;
					}
				} catch {
					// The preview and original exit status still describe the command.
				}
			}
			return result;
		} finally {
			await files.remove(marker, { force: true }).catch(() => {});
			if (!retain) await files.remove(directory, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * Checks out the repository at `SANDBOX_REPOSITORY_PATH` on a new `branch` from its default
	 * branch, or from what the conversation pushed (`#branchStart`), unless it is there already. A
	 * conversation keeps the repository it first checked out: a repository chosen later on the agent
	 * is for its next conversations.
	 *
	 * With `review`, it checks out a pull request's head to be reviewed instead: it fetches
	 * `refs/pull/<number>/head`, checks the commit it finds is `head`, and checks that commit out
	 * detached, on no branch. The sandbox opens no push window for it, so nothing it holds can be
	 * pushed. A head that is no longer the pull request's is `gone`.
	 */
	async checkout(
		repository: SandboxRepository,
		branch: string,
		review?: { number: number; head: string },
	): Promise<CheckoutResult> {
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
		if (review) {
			const reviewed = await this.#checkoutHead(container, name, review);
			if ("error" in reviewed) {
				await failed(reviewed.error);
				return reviewed;
			}
			return { checkedOut: true };
		}
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

	/** Puts a fresh clone on a pull request's head, detached (`checkout`'s `review`). */
	async #checkoutHead(
		container: Container,
		name: string,
		{ number, head }: { number: number; head: string },
	): Promise<{ ok: true } | { error: string; gone?: true }> {
		if (!Number.isSafeInteger(number) || number < 1 || !isCommitId(head)) {
			return { error: "The pull request to review is not a pull request and a commit id" };
		}
		const gone = (why: string) => ({
			error: `${name}#${number} cannot be reviewed at ${head.slice(0, 7)}: ${why}`,
			gone: true as const,
		});
		const fetched = await this.#exec(
			container,
			["git", "fetch", "--quiet", "origin", `refs/pull/${number}/head`],
			SANDBOX_REPOSITORY_PATH,
			CLONE_SECONDS,
		);
		if (fetched.exitCode !== 0) {
			if (/couldn't find remote ref/i.test(fetched.output)) {
				return gone("GitHub no longer has the pull request's head");
			}
			return {
				error: `The pull request's head could not be fetched.\n${fetched.output}`,
			};
		}
		const tip = await this.#exec(
			container,
			["git", "rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"],
			SANDBOX_REPOSITORY_PATH,
			30,
		);
		if (tip.exitCode !== 0 || tip.output.trim() !== head) {
			return gone("it is no longer the pull request's head on GitHub");
		}
		const switched = await this.#exec(
			container,
			["git", "checkout", "--quiet", "--detach", head],
			SANDBOX_REPOSITORY_PATH,
			CLONE_SECONDS,
		);
		if (switched.exitCode !== 0) {
			return {
				error: `The pull request's head could not be checked out.\n${switched.output}`,
			};
		}
		return { ok: true };
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
	async push(
		branch: string,
		message: string,
		author: CommitAuthor,
		model: string,
	): Promise<PushResult> {
		const committed = await this.commit(message, author, model);
		if ("error" in committed) return committed;
		return this.pushCommit(branch, committed.head);
	}

	/**
	 * The first half of `push`: commits every change in the checkout with `message`, unless there
	 * are none to commit, and says which commit the work is at. Refuses when the work has no commit
	 * the default branch does not. `open_pull_request` calls it alone when the repository has
	 * checks, which run on this commit before `pushCommit` pushes it.
	 */
	async commit(message: string, author: CommitAuthor, model: string): Promise<CommitResult> {
		const repository = this.#repository();
		if (!repository) return { error: "This sandbox has no repository checked out." };
		const container = await this.#ready();
		if (!(await this.#isGitCheckout(container))) {
			return {
				error: `${repository.owner}/${repository.name} is not checked out in this sandbox.`,
			};
		}
		return commitWork(
			(args, seconds = 60, env = {}) =>
				this.#exec(container, args, SANDBOX_REPOSITORY_PATH, seconds, env),
			repository.defaultBranch,
			message,
			author,
			model,
			this.ctx.storage.kv.get<string>(PUSHED_KEY) ?? null,
		);
	}

	/** Git in the checkout, as `./git-work.ts` runs it. */
	#git(container: Container): Git {
		return (args, seconds = 60, env = {}, outputLimit) =>
			this.#exec(
				container,
				["git", ...args],
				SANDBOX_REPOSITORY_PATH,
				seconds,
				env,
				undefined,
				false,
				outputLimit,
			);
	}

	async git(
		args: string[],
		seconds?: number,
		env?: Record<string, string>,
		outputLimit?: number,
	): Promise<CommandResult> {
		return this.#git(await this.#ready())(args, seconds, env, outputLimit);
	}

	/**
	 * Whether the checkout still is the commit `head` (`changedSince` in `./git-work.ts`).
	 * `open_pull_request` asks after each of the repository's checks that passed, since they run
	 * in the checkout and not on the commit itself.
	 */
	async changedSince(head: string): Promise<Comparison> {
		return changedSince(this.#git(await this.#ready()), head);
	}

	/**
	 * The checkout's state as a tree, before a turn's work (`./changes.ts`), or null when nothing
	 * is checked out. A turn of a repository sums up what it changed against it.
	 */
	async changesBase(): Promise<string | null> {
		const container = await this.#ready();
		if (!(await this.#isGitCheckout(container))) return null;
		return writeChangesBase(this.#git(container));
	}

	/** What the checkout changed since the state `base` names, as the reply's `data-changes` part. */
	async turnChanges(base: string): Promise<ChangesPartData | null> {
		const container = await this.#ready();
		if (!(await this.#isGitCheckout(container))) return null;
		return diffChanges(this.#git(container), base);
	}

	/**
	 * The second half of `push`: pushes the commit `head` to `branch`, unless the branch has it
	 * already, and commits nothing. It names the commit and not `HEAD`, so what changed in the
	 * checkout after `commit`, while the repository's checks ran, is not in the push.
	 */
	async pushCommit(branch: string, head: string): Promise<PushResult> {
		const repository = this.#repository();
		if (!repository) return { error: "This sandbox has no repository checked out." };
		if (!isCommitId(head)) return { error: "That is not a commit of this sandbox's." };
		const container = await this.#ready();
		const pushed = this.ctx.storage.kv.get<string>(PUSHED_KEY) ?? null;
		if (head === pushed) return { head, pushed: false };
		// The window is for this commit alone: `SandboxOutbound` refuses the push of any other.
		const window: PushWindow = { branch, from: pushed, head };
		this.#push = window;
		let result: CommandResult;
		try {
			result = await this.#git(container)(pushArguments(branch, head), PUSH_SECONDS);
		} finally {
			// Only its own: a push that outlives its turn must not close the window of the next.
			if (this.#push === window) this.#push = null;
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
	 * Creates a file that does not exist yet, making the directories it needs, in one exclusive,
	 * no-follow step inside the container (`CREATE_FILE_SCRIPT` in `./proof-scripts.ts`). It never
	 * replaces a file and never writes through a symlink.
	 */
	async createFile(path: string, content: string): Promise<WriteResult> {
		if (!path.startsWith(`${SANDBOX_REPOSITORY_PATH}/`))
			return { error: `${path} is not in the repository.` };
		const container = await this.#ready();
		return createProofFile(
			async (script, args, input) => {
				// The paths are argv and the content is standard input: none is in the program's source.
				const process = await container.exec(
					["timeout", "--kill-after=5s", "30s", "python3", "-I", "-c", script, ...args],
					{
						cwd: SANDBOX_ROOT,
						env: COMMAND_ENV,
						stdin: "pipe",
						stdout: "pipe",
						stderr: "combined",
					},
				);
				const feed = (async () => {
					const writer = process.stdin?.getWriter();
					await writer?.write(new TextEncoder().encode(input));
					await writer?.close();
				})().catch(() => {});
				const [output, exitCode] = await Promise.all([
					clipOutput(process.stdout),
					process.exitCode,
					feed,
				]);
				return { exitCode, output: output.text };
			},
			SANDBOX_REPOSITORY_PATH,
			path.slice(SANDBOX_REPOSITORY_PATH.length + 1),
			content,
		);
	}

	/**
	 * Runs a review proof's command in the checkout, in a session of its own, and ends it and its
	 * whole process group by the deadline, `seconds` from now, kill-after grace included. The
	 * result says whether any process the command started is still alive (`RUN_PROOF_SCRIPT` in
	 * `./proof-scripts.ts`).
	 */
	async runProof(command: string, seconds: number): Promise<ProofRun> {
		const container = await this.#ready();
		const missing = await this.#directoryProblem(container, SANDBOX_REPOSITORY_PATH);
		if (missing)
			return { exitCode: 1, output: missing, timedOut: false, notStarted: true, left: 0 };
		// The checkout may have been condemned while the directory check was pending.
		await this.#disposal.assertReusable(container);
		const nonce = crypto.randomUUID();
		const process = await container.exec(
			["python3", "-I", "-c", RUN_PROOF_SCRIPT, String(seconds), command, nonce],
			{ cwd: SANDBOX_REPOSITORY_PATH, env: COMMAND_ENV, stdout: "pipe", stderr: "combined" },
		);
		const [output, exitCode] = await Promise.all([clipOutput(process.stdout), process.exitCode]);
		return readProofRun(nonce, output.text, exitCode);
	}

	/**
	 * Throws the checkout away by destroying the container, which ends every process in it. A
	 * process that may still be writing to the checkout makes deleting its folder not enough. The
	 * next command starts on an empty machine.
	 */
	async discardCheckout(): Promise<void> {
		// Marked first: if the destroy fails, `#ready` refuses this container until one succeeds.
		await this.#disposal.discard(this.#container);
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
		this.#running = {
			engine: job.engine,
			provider: job.provider,
			model: job.model,
			access: job.access,
		};
		await container.setInactivityTimeout(ENGINE_SECONDS * 1000 + this.#idleMs);
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

	/**
	 * Starts a local MCP server's command in the sandbox's root, with `input` as its standard input,
	 * and returns its standard output (`./local-servers.ts`). Its own messages go to a log, so its
	 * output holds only its messages. It stops when its input ends, as the turn closes it, and after
	 * `ENGINE_SECONDS` at most. Its downloads go out as any command's do: package registries only.
	 */
	async startMcpServer(
		server: LocalCommand,
		input: ReadableStream<Uint8Array>,
	): Promise<ReadableStream<Uint8Array>> {
		const container = await this.#ready();
		const process = await container.exec(
			[
				"timeout",
				"--kill-after=10s",
				`${ENGINE_SECONDS}s`,
				"bash",
				"-c",
				`exec "$0" "$@" 2>>${MCP_SERVER_LOG}`,
				server.command,
				...server.args,
			],
			{
				cwd: SANDBOX_ROOT,
				// What the sandbox needs to reach the internet stays as it is.
				env: { ...server.env, ...COMMAND_ENV },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const stop = () => {
			try {
				process.kill(SIGTERM);
			} catch {
				// It has exited already.
			}
		};
		if (!process.stdin || !process.stdout) {
			stop();
			throw new Error("The command's input and output could not be opened");
		}
		input
			.pipeTo(process.stdin)
			.catch(() => {})
			.finally(() => setTimeout(stop, STOP_GRACE_MS));
		return process.stdout as ReadableStream<Uint8Array>;
	}

	async stopEngine(): Promise<boolean> {
		if (this.#openCode) {
			await this.#openCode.stop();
			return true;
		}
		const process = this.#engine;
		if (!process) return false;
		process.kill(SIGINT);
		setTimeout(() => {
			if (this.#engine === process) process.kill(SIGTERM);
		}, STOP_GRACE_MS);
		return true;
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
		if (container.running) await container.setInactivityTimeout(this.#idleMs);
	}

	/**
	 * Starts a turn of OpenCode on its server in the container, which the turn starts, or starts
	 * over, unless it runs with the turn's settings (`./opencode-server.ts`). The server stays up
	 * for the next turn. Its events end with the turn, which the sandbox stops at `ENGINE_SECONDS`.
	 */
	async #startOpenCode(container: Container, job: EngineJob): Promise<ReadableStream<Uint8Array>> {
		// Before the server is reached: reconnecting its MCP server goes out as the turn's request.
		this.#running = {
			engine: job.engine,
			provider: job.provider,
			model: job.model,
			access: job.access,
		};
		await container.setInactivityTimeout(ENGINE_SECONDS * 1000 + this.#idleMs);
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
		// A turn settling as its conversation was erased writes nothing back (AGT-156).
		if (turn.session !== null && !isForgotten(this.ctx.storage.kv)) {
			this.ctx.storage.kv.put(OPENCODE_SESSION_KEY, turn.session);
		}
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
			ensure: async (env, signal) => {
				const started = await this.#exec(
					container,
					["bash", "-c", OPENCODE_SERVER_SCRIPT],
					SANDBOX_ROOT,
					OPENCODE_SCRIPT_SECONDS,
					{ ...env, OPENCODE_SETTINGS: JSON.stringify(env) },
					signal,
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
					// A start racing its conversation's erasure writes nothing back (AGT-156).
					if (!isForgotten(this.ctx.storage.kv)) {
						this.ctx.storage.kv.put(SESSION_KEY, session);
					}
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
		await this.#disposal.destroy(this.#container);
	}

	/**
	 * What the sandbox keeps of its conversation, for a move of the workspace to take to the
	 * sandbox of the same name where it goes (`move.ts` in the registry package). The container's
	 * files stay: a container starts without them after it sleeps anyway.
	 */
	moveKeys(): [string, unknown][] {
		return readKept(this.ctx.storage.kv);
	}

	/** Takes what the old sandbox kept, in place of anything an earlier try of the move left. */
	takeKeys(entries: [string, unknown][]): void {
		this.ctx.storage.transactionSync(() => replaceKept(this.ctx.storage.kv, entries));
	}

	/**
	 * Marks the sandbox as being erased with its conversation, which `forgetKeys` asks for before
	 * it wipes what the sandbox kept. Only the conversation's own erasure paths call it (AGT-156).
	 */
	markForForget(): void {
		markForgotten(this.ctx.storage.kv);
	}

	/**
	 * Stops the container and forgets what the conversation left in this place. The conversation
	 * calls it as it is deleted or forgotten after a move, after `markForForget`: an unmarked
	 * sandbox keeps its keys, so a caller that reaches it directly cannot wipe a live one (AGT-156).
	 */
	async forgetKeys(): Promise<void> {
		// The guard goes first: an unmarked sandbox is a live one, and stops nothing (AGT-156).
		assertForgotten(this.ctx.storage.kv);
		await this.destroy();
		forgetKept(this.ctx.storage.kv);
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

	/**
	 * Runs `argv` under GNU `timeout`, with its output clipped as it streams, until `signal` gives
	 * up. A numeric output mode keeps a bounded prefix for output that must be parsed whole.
	 */
	async #exec(
		container: Container,
		argv: string[],
		cwd: string,
		timeoutSeconds: number,
		env: Record<string, string> = {},
		signal?: AbortSignal,
		commandPreview = false,
		outputMode?: number | "search",
	): Promise<CommandResult> {
		const process = await container.exec(
			["timeout", "--kill-after=5s", `${timeoutSeconds}s`, ...argv],
			{
				cwd,
				env: { ...COMMAND_ENV, ...env },
				stdout: "pipe",
				stderr: outputMode === "search" ? "pipe" : "combined",
				...(signal === undefined ? {} : { signal }),
			},
		);
		if (outputMode === "search") {
			const [matches, diagnostic, exitCode] = await Promise.all([
				boundedSearchOutput(process.stdout),
				clipOutput(process.stderr),
				process.exitCode,
			]);
			return {
				exitCode,
				output: exitCode === 0 || exitCode === 1 ? matches : diagnostic.text,
				timedOut: TIMED_OUT.has(exitCode),
			};
		}
		const [output, exitCode] = await Promise.all([
			outputMode === undefined
				? commandPreview
					? clipCommandOutput(process.stdout)
					: clipOutput(process.stdout)
				: readPrefix(process.stdout, outputMode),
			process.exitCode,
		]);
		return {
			exitCode,
			output: output.text,
			timedOut: TIMED_OUT.has(exitCode),
			omitted: output.omitted,
		};
	}

	async #ready(): Promise<Container> {
		const container = this.#container;
		if (!container) throw new Error(SANDBOX_NOT_OFFERED);
		// A condemned container is not handed out until a destroy of it has succeeded.
		await this.#disposal.assertReusable(container);
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
			await container.setInactivityTimeout(this.#idleMs);
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
 * While an engine runs a turn, its requests to the model go out with the workspace's key once what
 * they ask the provider to do has been checked (`./model-requests.ts`), and the conversation
 * records each in the run's trace with the usage its answer reports (`./meter.ts`).
 * Those to Gateweave's tools never go out: the conversation answers them, with the turn's token.
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
		const toModel = decision.credentials;
		if ((toModel === "anthropic" || toModel === "openai" || toModel === "google") && running) {
			const conversation = this.#conversations().getByName(running.access.meter.conversation);
			return sendModelRequest(request, toModel, running, {
				settings: env,
				meter: conversation as unknown as EngineMeter,
				waitUntil: (promise) => this.ctx.waitUntil(promise),
			});
		}
		if (decision.credentials === "tools" && tools) {
			const conversation = this.#conversations().getByName(tools.conversation);
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

	/** The conversations where the sandbox is, as a workspace's objects are all in one place. */
	#conversations(): DurableObjectNamespace {
		const env = this.env as unknown as OutboundEnv;
		const { sandbox } = this.ctx.props;
		const id = sandbox && env.SANDBOX ? env.SANDBOX.idFromString(sandbox) : null;
		return objectsIn(env.CONVERSATIONS, id?.jurisdiction);
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
