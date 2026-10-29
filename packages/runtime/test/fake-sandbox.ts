/**
 * Sandboxes for the tests, which have no containers: files in memory, and commands that are only
 * recorded. `MemorySandbox` stands behind the tools directly; `FakeSandbox` is the Durable Object
 * the test Worker binds as `SANDBOX`, so a conversation reaches it as it would a real one.
 */
import { DurableObject } from "cloudflare:workers";
import type { SandboxRepository } from "@gateweave/agents-model";
import type { CheckoutPort, CheckoutResult } from "../src/checkout";
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

export class MemorySandbox implements CheckoutPort {
	readonly files = new Map<string, string>();
	readonly commands: RanCommand[] = [];
	readonly checkouts: Checkout[] = [];
	/** What the next commands answer, in order; then each exits 0 and prints its command line. */
	readonly answers: CommandResult[] = [];
	/** What the next checkouts answer, in order; then each checks out. */
	readonly checkoutAnswers: CheckoutResult[] = [];

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
}

export class FakeSandbox extends DurableObject implements CheckoutPort {
	readonly #memory = new MemorySandbox();
	#destroyed = false;

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

	destroy(): void {
		this.#destroyed = true;
	}

	/** What the tests check: files, commands, checkouts, and whether the conversation destroyed it. */
	seen() {
		return {
			files: Object.fromEntries(this.#memory.files),
			commands: this.#memory.commands,
			checkouts: this.#memory.checkouts,
			destroyed: this.#destroyed,
		};
	}
}
