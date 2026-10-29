/**
 * Sandboxes for the tests, which have no containers: files in memory, and commands that are only
 * recorded. `MemorySandbox` stands behind the tools directly; `FakeSandbox` is the Durable Object
 * the test Worker binds as `SANDBOX`, so a conversation reaches it as it would a real one.
 */
import { DurableObject } from "cloudflare:workers";
import type { CommandResult, ReadResult, SandboxPort, WriteResult } from "../src/sandbox-tools";

export interface RanCommand {
	command: string;
	cwd: string;
	timeoutSeconds: number;
}

export class MemorySandbox implements SandboxPort {
	readonly files = new Map<string, string>();
	readonly commands: RanCommand[] = [];
	/** What the next commands answer, in order; then each exits 0 and prints its command line. */
	readonly answers: CommandResult[] = [];

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
}

export class FakeSandbox extends DurableObject implements SandboxPort {
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

	destroy(): void {
		this.#destroyed = true;
	}

	/** What the tests check: the files, the commands, and whether the conversation destroyed it. */
	seen() {
		return {
			files: Object.fromEntries(this.#memory.files),
			commands: this.#memory.commands,
			destroyed: this.#destroyed,
		};
	}
}
