/**
 * A conversation's sandbox: a Durable Object with a Linux container of its own, where the turns of
 * an agent with a sandbox run commands and read and write files (`./sandbox-tools.ts`). It has no
 * route; only its conversation reaches it, over RPC, under the conversation's own name.
 *
 * The container starts on the first call and stops after `IDLE_MINUTES` without one, and its disk
 * goes with it. It has no internet: every HTTP and HTTPS request it makes comes to
 * `SandboxOutbound`, which lets downloads from package registries through and nothing else
 * (`./outbound.ts`). It holds no secret of the workspace's, so a command has none to leak.
 *
 * A deployment offers sandboxes by binding this class as `SANDBOX` with a container (see
 * `wrangler.jsonc`); its image is `sandbox/Dockerfile`.
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { SANDBOX_NOT_OFFERED } from "@gateweave/agents-model";
import { failureForLogs } from "./models";
import { decideOutbound } from "./outbound";
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
};

/** `timeout`'s exit codes for a command it stopped, and one it had to kill. */
const TIMED_OUT = new Set([124, 137]);

/** The app's Worker exports `SandboxOutbound` beside this class. */
interface SandboxState extends DurableObjectState {
	readonly exports: Cloudflare.Exports & {
		readonly SandboxOutbound: (options?: object) => Fetcher;
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
		this.#outbound = ctx.exports.SandboxOutbound({});
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
		const process = await container.exec(
			["timeout", "--kill-after=5s", `${timeoutSeconds}s`, "bash", "-c", command],
			{ cwd, env: COMMAND_ENV, stdout: "pipe", stderr: "combined" },
		);
		const [output, exitCode] = await Promise.all([clipOutput(process.stdout), process.exitCode]);
		return { exitCode, output: output.text, timedOut: TIMED_OUT.has(exitCode) };
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

/**
 * Where the container's HTTP and HTTPS requests come out: those `decideOutbound` allows go on from
 * the Worker, and the rest get a 403 whose text says why, which the command prints.
 */
export class SandboxOutbound extends WorkerEntrypoint {
	override async fetch(request: Request): Promise<Response> {
		const decision = decideOutbound(request.method, new URL(request.url));
		if (!decision.allow) return new Response(`${decision.reason}\n`, { status: 403 });
		// A redirect is the client's to follow, so that each address it leads to is asked about too.
		return fetch(request, { redirect: "manual" });
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
