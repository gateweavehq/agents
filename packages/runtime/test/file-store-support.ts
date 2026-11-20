/**
 * What the tests of the files store share (`../src/file-store.ts`): a conversation's own storage
 * to keep the files in, a stand-in for GitHub, and a sandbox whose ripgrep and `rm` answer from
 * its files in memory, so the same calls can be made of both kinds of port.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FakeGit } from "@gateweave/agents-github/testing";
import type { SandboxRepository } from "@gateweave/agents-model";
import { getAgentByName } from "agents";
import type { ToolSet } from "ai";
import { vi } from "vitest";
import { conversationName } from "../src";
import { FileStore } from "../src/file-store";
import { readGlob } from "../src/glob";
import type { CommandResult } from "../src/sandbox-tools";
import type { RunRecorder } from "../src/trace";
import { MemorySandbox } from "./fake-sandbox";

/** The conversation's branch, as `conversationBranch` names one. */
export const BRANCH = "gateweave/conversation-1";

export const AUTHOR = { name: "Reviewer", email: "1+gateweave[bot]@users.noreply.github.com" };

/** The fake's one repository as the registry would hand it to a turn. */
export function repositoryOf(fake: FakeGit): SandboxRepository {
	return {
		owner: fake.owner,
		name: fake.name,
		externalId: "4242",
		installationId: "77",
		defaultBranch: fake.defaultBranch,
	};
}

/** A name for a conversation of its own, in a workspace of its own. */
export function newConversation(workspaceId: string = crypto.randomUUID()): string {
	return conversationName(workspaceId, crypto.randomUUID());
}

/**
 * Runs `body` inside a real `ConversationAgent`, with its storage: where the store's tables
 * live. A Durable Object's storage answers only inside the object, so a test's whole body goes
 * in here.
 */
export async function inConversation<T>(
	body: (storage: DurableObjectStorage) => Promise<T>,
	name: string = newConversation(),
): Promise<T> {
	const stub = await getAgentByName(env.CONVERSATIONS, name);
	return runInDurableObject(stub as never, (_instance: unknown, state: DurableObjectState) =>
		body(state.storage),
	);
}

/** GitHub is the fake from here on, for whatever calls `fetch`. */
export function useGitHub(fake: FakeGit): void {
	vi.stubGlobal("fetch", fake.fetch);
}

/**
 * A store over `storage` whose tokens are the fake's: the one that only reads for a read, the
 * one that writes for a write. `asked` records what each token was asked for.
 */
export function storeOver(
	storage: DurableObjectStorage,
	fake: FakeGit,
	tokens: { read?: string; write?: string } = {},
) {
	const asked: { repository: string; access: "read" | "write" }[] = [];
	// A clock that never gives the same moment twice, so what was fetched first is the oldest.
	let moment = Date.now();
	const store = new FileStore(
		storage,
		async (repository, access) => {
			asked.push({ repository: `${repository.owner}/${repository.name}`, access });
			return access === "read" ? (tokens.read ?? fake.readToken) : (tokens.write ?? fake.token);
		},
		() => ++moment,
	);
	return { store, asked };
}

/** A recorder that only keeps how each call ended, as the trace would. */
export function recorder() {
	const ended: unknown[] = [];
	const run = {
		targets: { tainted: false },
		toolStarted: () => "span",
		toolEnded: (_span: string, outcome: unknown) => {
			ended.push(outcome);
		},
	} as unknown as RunRecorder;
	return { run, ended };
}

/** Calls one of `tools` as the model would. */
export function calling(tools: ToolSet) {
	return (name: string, input: object) => {
		const execute = tools[name]?.execute as
			| ((input: object, options: { toolCallId: string; messages: [] }) => Promise<unknown>)
			| undefined;
		if (!execute) throw new Error(`No tool ${name}`);
		return execute(input, { toolCallId: "call-1", messages: [] });
	};
}

/** Every row of the store's tables, as text, to look for what must not be in them. */
export function storedText(storage: DurableObjectStorage): string {
	const tables = ["file_checkout", "file_listing", "file_blobs", "file_changes"];
	return tables
		.map((table) =>
			storage.sql
				.exec(`SELECT * FROM ${table}`)
				.toArray()
				.map((row) =>
					Object.values(row)
						.map((value) =>
							value instanceof ArrayBuffer ? new TextDecoder().decode(value) : String(value),
						)
						.join("|"),
				)
				.join("\n"),
		)
		.join("\n");
}

/** How many rows each of the store's tables holds. */
export function rowCounts(storage: DurableObjectStorage): Record<string, number> {
	const count = (table: string) =>
		storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
	return {
		checkout: count("file_checkout"),
		listing: count("file_listing"),
		blobs: count("file_blobs"),
		changes: count("file_changes"),
	};
}

/** The words of a command line as bash would pass them, for the lines `sandboxFiles` writes. */
function shellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quoted = false;
	let any = false;
	for (let index = 0; index < command.length; index++) {
		const char = command.charAt(index);
		if (quoted) {
			if (char === "'") quoted = false;
			else word += char;
		} else if (char === "'") {
			quoted = true;
			any = true;
		} else if (char === "\\" && index + 1 < command.length) {
			word += command.charAt(++index);
			any = true;
		} else if (char === " ") {
			if (any || word !== "") words.push(word);
			word = "";
			any = false;
		} else {
			word += char;
		}
	}
	if (any || word !== "") words.push(word);
	return words;
}

function compare(a: string, b: string): number {
	const left = a.split("/");
	const right = b.split("/");
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const one = left[index] ?? "";
		const other = right[index] ?? "";
		if (one !== other) return one < other ? -1 : 1;
	}
	return left.length - right.length;
}

/**
 * A sandbox in memory whose `rg` and `rm` answer from its files, for the two command lines
 * `sandboxFiles` writes and the one it deletes with. It is not ripgrep, and it is held to
 * ripgrep: `ripgrep-recorded.test.ts` runs it over the files and the command lines that the
 * sandbox image's own ripgrep was recorded on (`ripgrep/recorded.json`), and its exit code and
 * output have to be the recorded ones, case by case. Its globs are read by the store's
 * `readGlob`, held from the working directory as ripgrep holds them, and the same recordings
 * hold that too. It has no `.git` and knows nothing of `.gitignore`; the recordings show what
 * ripgrep does with both, and the test says where that differs. Its `rm` is not recorded.
 */
export class RipgrepSandbox extends MemorySandbox {
	override async run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult> {
		this.commands.push({ command, cwd, timeoutSeconds });
		const words = shellWords(command);
		const answer = (exitCode: number, output: string) => ({ exitCode, output, timedOut: false });
		if (words[0] === "rm") {
			const path = words.at(-1) ?? "";
			if (this.files.delete(path)) return answer(0, "");
			const directory = [...this.files.keys()].some((file) => file.startsWith(`${path}/`));
			const why = directory ? "Is a directory" : "No such file or directory";
			return answer(1, `rm: cannot remove '${path}': ${why}\n`);
		}
		if (words[0] !== "rg") return answer(127, `${words[0]}: command not found\n`);
		const target = words.at(-1) ?? "";
		const globs: string[] = [];
		let pattern: string | null = null;
		for (let index = 1; index < words.length - 2; index++) {
			if (words[index] === "--glob") globs.push(words[++index] ?? "");
			else if (words[index] === "-e") pattern = words[++index] ?? "";
		}
		const listing = words.includes("--files");
		const single = this.files.has(target);
		const under = [...this.files.keys()].filter(
			(file) => file === target || file.startsWith(`${target}/`),
		);
		if (under.length === 0) {
			const why = "No such file or directory (os error 2)";
			return answer(
				2,
				listing
					? `${target}: IO error for operation on ${target}: ${why}\n`
					: `${target}: ${why}\n`,
			);
		}
		const wanted = globs.filter((glob) => glob !== "!.git").map((glob) => readGlob(glob));
		const listed = under
			.filter((file) => {
				// A file named itself is taken whatever the globs say.
				if (single) return true;
				const parts = file.slice(cwd.length + 1).split("/");
				return wanted.every((glob) => !("error" in glob) && glob.matches(parts));
			})
			.sort(compare);
		if (listing) {
			return listed.length === 0 ? answer(1, "") : answer(0, `${listed.join("\n")}\n`);
		}
		const expression = new RegExp(pattern ?? "", words.includes("--ignore-case") ? "i" : "");
		const encoder = new TextEncoder();
		let output = "";
		for (const file of listed) {
			const content = this.files.get(file) ?? "";
			const zero = content.indexOf("\0");
			if (zero !== -1) {
				// Skipped among others; named itself, ripgrep says it matched and shows nothing.
				if (single && expression.test(content)) {
					const offset = encoder.encode(content.slice(0, zero)).length;
					output += `binary file matches (found "\\0" byte around offset ${offset})\n`;
				}
				continue;
			}
			const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
			let number = 0;
			for (let start = 0; start < text.length; ) {
				const end = text.indexOf("\n", start);
				const line = text.slice(start, end === -1 ? text.length : end);
				start = end === -1 ? text.length : end + 1;
				number++;
				if (!expression.test(line)) continue;
				// The newline that ends a line is counted with it.
				const long = encoder.encode(line).length + (end === -1 ? 0 : 1) > 500;
				const shown = long ? "[Omitted long matching line]" : line;
				output += `${single ? "" : `${file}:`}${number}:${shown}\n`;
			}
		}
		return output === "" ? answer(1, "") : answer(0, output);
	}
}
