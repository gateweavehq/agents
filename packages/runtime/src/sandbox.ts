/**
 * A conversation's sandbox: a Durable Object with a Linux container of its own, where the turns of
 * an agent with a sandbox run commands and read and write files (`./sandbox-tools.ts`). It has no
 * route; only its conversation reaches it, over RPC, under the conversation's own name.
 *
 * The container starts on the first call and stops after `IDLE_MINUTES` without one, and its disk
 * goes with it. It has no internet: every HTTP and HTTPS request it makes comes to
 * `SandboxOutbound`, which lets downloads from package registries through, and git's fetches of
 * the repository the conversation checked out, and nothing else (`./outbound.ts`). It holds no
 * secret of the workspace's, so a command has none to leak: the token for that repository is
 * added on the way out.
 *
 * A deployment offers sandboxes by binding this class as `SANDBOX` with a container (see
 * `wrangler.jsonc`); its image is `sandbox/Dockerfile`.
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { sharedApp } from "@gateweave/agents-github";
import {
	SANDBOX_NOT_OFFERED,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import type { CheckoutResult } from "./checkout";
import { failureForLogs } from "./models";
import { decideOutbound, withGitHubToken } from "./outbound";
import { clipOutput } from "./output";
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

/** How long a clone may take before the checkout gives up. */
const CLONE_SECONDS = 300;

const REPOSITORY_KEY = "repository";

/** `timeout`'s exit codes for a command it stopped, and one it had to kill. */
const TIMED_OUT = new Set([124, 137]);

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

export class RunnerSandbox extends DurableObject implements SandboxPort {
	readonly #container: Container | undefined;
	readonly #outbound: Fetcher;
	/** The container's start under way, which every call waits for. */
	#starting: Promise<void> | undefined;

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
	 * branch, unless it is there already. A conversation keeps the repository it first checked out:
	 * a repository chosen later on the agent is for its next conversations.
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
		if (clone.exitCode !== 0) {
			await this.#exec(container, ["rm", "-rf", SANDBOX_REPOSITORY_PATH], SANDBOX_ROOT, 30);
			return { error: `${name} could not be checked out.\n${clone.output}` };
		}
		const switched = await this.#exec(
			container,
			["git", "switch", "--create", branch],
			SANDBOX_REPOSITORY_PATH,
			30,
		);
		if (switched.exitCode !== 0) {
			return {
				error: `${name} is cloned, but the branch ${branch} was not made.\n${switched.output}`,
			};
		}
		return { checkedOut: true };
	}

	/** The repository the conversation checked out, which `SandboxOutbound` lets git fetch. */
	repository(): SandboxRepository | null {
		return this.#repository();
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
	): Promise<CommandResult> {
		const process = await container.exec(
			["timeout", "--kill-after=5s", `${timeoutSeconds}s`, ...argv],
			{ cwd, env: COMMAND_ENV, stdout: "pipe", stderr: "combined" },
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
				instance: "standard-1",
				enableInternet: false,
			});
			// The intercepts last as long as this run of the container.
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

/** The settings `SandboxOutbound` reads: the sandboxes, and the deployment's GitHub App. */
interface OutboundEnv {
	SANDBOX?: DurableObjectNamespace<RunnerSandbox>;
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
}

/**
 * Where the container's HTTP and HTTPS requests come out: those `decideOutbound` allows go on from
 * the Worker, and the rest get a 403 whose text says why, which the command prints. A fetch of the
 * conversation's repository goes out with a token minted for that repository alone, to read it.
 */
export class SandboxOutbound extends WorkerEntrypoint<Cloudflare.Env, OutboundProps> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const repository = url.hostname === "github.com" ? await this.#repository() : null;
		const decision = decideOutbound(request.method, url, repository);
		if (!decision.allow) return new Response(`${decision.reason}\n`, { status: 403 });
		let outgoing = request;
		if (decision.credentials === "github" && repository) {
			const token = await this.#token(repository);
			if (token === null) {
				const reason = "GitHub gave this sandbox no token to read the repository with";
				return new Response(`${reason}\n`, { status: 502 });
			}
			outgoing = withGitHubToken(request, token);
		}
		// A redirect is the client's to follow, so that each address it leads to is asked about too.
		return fetch(outgoing, { redirect: "manual" });
	}

	async #repository(): Promise<SandboxRepository | null> {
		const env = this.env as unknown as OutboundEnv;
		const { sandbox } = this.ctx.props;
		if (!env.SANDBOX || !sandbox) return null;
		return env.SANDBOX.get(env.SANDBOX.idFromString(sandbox)).repository();
	}

	async #token(repository: SandboxRepository): Promise<string | null> {
		const env = this.env as unknown as OutboundEnv;
		const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = env;
		if (!appId || !privateKey) return null;
		try {
			return await sharedApp({ appId, privateKey }).repositoryToken(
				repository.installationId,
				repository.externalId,
				{ contents: "read" },
			);
		} catch (error) {
			console.error("A sandbox's GitHub token was not minted", failureForLogs(error));
			return null;
		}
	}
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
