/**
 * Sandboxes for the tests, which have no containers: files in memory, and commands that are only
 * recorded. `MemorySandbox` stands behind the tools directly; `FakeSandbox` is the Durable Object
 * the test Worker binds as `SANDBOX`, so a conversation reaches it as it would a real one. An
 * engine writes what a test scripted for it.
 */
import { DurableObject } from "cloudflare:workers";
import type { SandboxRepository } from "@gateweave/agents-model";
import type { CheckoutPort, CheckoutResult } from "../src/checkout";
import type { EngineJob, EnginePort } from "../src/engines";
import type { CommitAuthor, PushPort, PushResult } from "../src/pull-requests";
import type { CommandResult, ReadResult, WriteResult } from "../src/sandbox-tools";

export interface RanCommand {
	command: string;
	cwd: string;
	timeoutSeconds: number;
}

export interface Checkout {
	repository: SandboxRepository;
	branch: string;
}

export interface Push {
	branch: string;
	message: string;
	author: CommitAuthor;
}

export class MemorySandbox implements CheckoutPort, PushPort {
	readonly files = new Map<string, string>();
	readonly commands: RanCommand[] = [];
	readonly checkouts: Checkout[] = [];
	/** What the next commands answer, in order; then each exits 0 and prints its command line. */
	readonly answers: CommandResult[] = [];
	/** What the next checkouts answer, in order; then each checks out. */
	readonly checkoutAnswers: CheckoutResult[] = [];
	readonly pushes: Push[] = [];
	/** What the next pushes answer, in order; then each pushes a new commit. */
	readonly pushAnswers: PushResult[] = [];

	async run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult> {
		this.commands.push({ command, cwd, timeoutSeconds });
		return this.answers.shift() ?? { exitCode: 0, output: `ran: ${command}`, timedOut: false };
	}

	async readFile(path: string): Promise<ReadResult> {
		const content = this.files.get(path);
		return content === undefined ? { error: `${path} does not exist.` } : { content };
	}

	async writeFile(path: string, content: string): Promise<WriteResult> {
		this.files.set(path, content);
		return { written: new TextEncoder().encode(content).length };
	}

	async checkout(repository: SandboxRepository, branch: string): Promise<CheckoutResult> {
		this.checkouts.push({ repository, branch });
		return this.checkoutAnswers.shift() ?? { checkedOut: true };
	}

	async push(branch: string, message: string, author: CommitAuthor): Promise<PushResult> {
		this.pushes.push({ branch, message, author });
		const head = String(this.pushes.length).repeat(40).slice(0, 40);
		return this.pushAnswers.shift() ?? { head, pushed: true };
	}
}

/** What a turn of an engine writes, and whether it then waits until it is stopped. */
export interface EngineScript {
	lines: string[];
	untilStopped?: boolean;
}

export class FakeSandbox extends DurableObject implements CheckoutPort, PushPort, EnginePort {
	readonly #memory = new MemorySandbox();
	#destroyed = false;
	readonly #jobs: EngineJob[] = [];
	readonly #scripts: EngineScript[] = [];
	/** Ends the turn of the engine that waits to be stopped. */
	#release: (() => void) | null = null;
	#stops = 0;

	run(command: string, cwd: string, timeoutSeconds: number) {
		return this.#memory.run(command, cwd, timeoutSeconds);
	}

	readFile(path: string) {
		return this.#memory.readFile(path);
	}

	writeFile(path: string, content: string) {
		return this.#memory.writeFile(path, content);
	}

	checkout(repository: SandboxRepository, branch: string) {
		return this.#memory.checkout(repository, branch);
	}

	push(branch: string, message: string, author: CommitAuthor) {
		return this.#memory.push(branch, message, author);
	}

	/** What the next turn of an engine writes; one without a script writes nothing. */
	scriptEngine(script: EngineScript): void {
		this.#scripts.push(script);
	}

	async startEngine(job: EngineJob): Promise<ReadableStream<Uint8Array>> {
		this.#jobs.push(job);
		const { lines, untilStopped = false } = this.#scripts.shift() ?? { lines: [] };
		const { readable, writable } = new IdentityTransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		void (async () => {
			for (const line of lines)
				await writer.write(
					encoder.encode(`${line}
`),
				);
			if (untilStopped) await new Promise<void>((resolve) => (this.#release = resolve));
			await writer.close();
		})();
		return readable;
	}

	async stopEngine(): Promise<void> {
		this.#stops += 1;
		this.#release?.();
		this.#release = null;
	}

	destroy(): void {
		this.#destroyed = true;
	}

	/**
	 * What the tests check: files, commands, checkouts, pushes, and whether the conversation
	 * destroyed it.
	 */
	seen() {
		return {
			files: Object.fromEntries(this.#memory.files),
			commands: this.#memory.commands,
			checkouts: this.#memory.checkouts,
			pushes: this.#memory.pushes,
			engine: this.#jobs,
			stops: this.#stops,
			destroyed: this.#destroyed,
		};
	}
}
