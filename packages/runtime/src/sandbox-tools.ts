/**
 * The tools of a turn with a sandbox: running commands, and reading, writing, editing, finding and
 * searching files on the conversation's own Linux machine (`./sandbox.ts`). They reach it through
 * `SandboxPort`, so the tests can stand a fake in for the container. Each call joins the trace
 * like an MCP server's, with its sizes and never its content.
 */
import { SANDBOX_IDLE_MINUTES } from "@gateweave/agents-model";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { traced } from "./tools";
import type { RunRecorder } from "./trace";

/** Where the sandbox keeps the work; relative paths start here. */
export const SANDBOX_ROOT = "/workspace";

/** The server the trace names for these tools. */
export const SANDBOX_SERVER = "sandbox";

/** Minutes without a request after which a sandbox stops, and its files with it. */
export const IDLE_MINUTES = SANDBOX_IDLE_MINUTES;

export const SANDBOX_LIMITS = {
	/** Seconds a command may run when the model does not say, and at most. */
	commandSeconds: 120,
	maxCommandSeconds: 600,
	/** Seconds a search or a listing of files may take. */
	searchSeconds: 60,
	/** Lines `read_file` returns at once, and characters of each line. */
	readLines: 2_000,
	lineLength: 2_000,
	/** Characters `write_file` takes, and a command line. */
	written: 1_000_000,
	command: 20_000,
};

/** How a command went: its exit code, and its output, stdout and stderr together, clipped. */
export interface CommandResult {
	exitCode: number;
	output: string;
	/** It ran out of time and was stopped. */
	timedOut: boolean;
}

/** A file's text, or why it could not be read, in words the model reads. */
export type ReadResult = { content: string } | { error: string };

/** How many bytes went into the file, or why none did. */
export type WriteResult = { written: number } | { error: string };

/** What the tools need of a sandbox. `RunnerSandbox` is the real one. */
export interface SandboxPort {
	/** Runs a bash command line in `cwd`, stopped after `timeoutSeconds`. */
	run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult>;
	readFile(path: string): Promise<ReadResult>;
	/** Writes the file, making the directories it needs. */
	writeFile(path: string, content: string): Promise<WriteResult>;
}

/**
 * A path the model gave, made absolute and plain, or null when it leads out of the sandbox's root.
 * It keeps the file tools to the work; it is not a wall, since a command can read anything on a
 * machine that holds nothing but the work.
 */
export function sandboxPath(path: string): string | null {
	const parts: string[] = [];
	const absolute = path.startsWith("/") ? path : `${SANDBOX_ROOT}/${path}`;
	for (const part of absolute.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.pop() === undefined) return null;
		} else {
			parts.push(part);
		}
	}
	const plain = `/${parts.join("/")}`;
	return plain === SANDBOX_ROOT || plain.startsWith(`${SANDBOX_ROOT}/`) ? plain : null;
}

/** The sandbox's tools for one turn, traced in `run`. */
export function sandboxTools(sandbox: SandboxPort, run: RunRecorder): ToolSet {
	const tools: ToolSet = {
		run_command: tool({
			description: `Runs a bash command line on this conversation's Linux machine and returns its exit code and output, stdout and stderr together; long output keeps its start and end. It is Debian with Node.js 24, npm, Python 3, git, ripgrep (rg), curl and jq. Package registries (npm, PyPI, crates.io, Go modules) can be downloaded from; no other address can be reached. Files stay between turns while the machine is in use; after ${IDLE_MINUTES} minutes without use it stops, and the next command starts on an empty one. Nothing reads from stdin, so commands that ask questions must be told the answers.`,
			inputSchema: z.object({
				command: z.string().min(1).max(SANDBOX_LIMITS.command).describe("The command line"),
				cwd: z
					.string()
					.max(1_000)
					.optional()
					.describe(`The directory it runs in; ${SANDBOX_ROOT} when left out`),
				timeout_seconds: z
					.number()
					.int()
					.min(1)
					.max(SANDBOX_LIMITS.maxCommandSeconds)
					.optional()
					.describe(
						`When to stop it, in seconds; ${SANDBOX_LIMITS.commandSeconds} when left out, at most ${SANDBOX_LIMITS.maxCommandSeconds}`,
					),
			}),
			execute: async ({ command, cwd, timeout_seconds }) => {
				const seconds = timeout_seconds ?? SANDBOX_LIMITS.commandSeconds;
				const result = await sandbox.run(command, within(cwd ?? SANDBOX_ROOT), seconds);
				return describeCommand(result, seconds);
			},
		}),
		read_file: tool({
			description: `Reads a text file, each line after its number and a tab, ${SANDBOX_LIMITS.readLines} lines at a time. The numbers are not part of the file: leave them out of edit_file.`,
			inputSchema: z.object({
				path: z.string().min(1).max(1_000).describe(`Absolute, or from ${SANDBOX_ROOT}`),
				offset: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The first line to read; 1 when left out"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(SANDBOX_LIMITS.readLines)
					.optional()
					.describe(`How many lines; ${SANDBOX_LIMITS.readLines} when left out`),
			}),
			execute: async ({ path, offset = 1, limit = SANDBOX_LIMITS.readLines }) => {
				const file = within(path);
				return numbered(file, await readText(sandbox, file), offset, limit);
			},
		}),
		write_file: tool({
			description:
				"Writes a file whole, making it and its directories when they do not exist, and replacing what it held when it does. To change part of a file, use edit_file.",
			inputSchema: z.object({
				path: z.string().min(1).max(1_000).describe(`Absolute, or from ${SANDBOX_ROOT}`),
				content: z.string().max(SANDBOX_LIMITS.written).describe("Everything the file holds"),
			}),
			execute: async ({ path, content }) => {
				const file = within(path);
				const result = await sandbox.writeFile(file, content);
				if ("error" in result) throw new Error(result.error);
				return `Wrote ${result.written} bytes to ${file}.`;
			},
		}),
		edit_file: tool({
			description:
				"Replaces text in a file with new text. The old text must be in the file exactly as written there, whitespace included, and only once unless replace_all is set; read the file first.",
			inputSchema: z.object({
				path: z.string().min(1).max(1_000).describe(`Absolute, or from ${SANDBOX_ROOT}`),
				old_text: z.string().min(1).max(SANDBOX_LIMITS.written).describe("The text to replace"),
				new_text: z.string().max(SANDBOX_LIMITS.written).describe("What replaces it"),
				replace_all: z
					.boolean()
					.optional()
					.describe("Replace every place it is found, not just one"),
			}),
			execute: async ({ path, old_text, new_text, replace_all = false }) => {
				const file = within(path);
				if (old_text === new_text) throw new Error("The new text is the same as the old.");
				const content = await readText(sandbox, file);
				const found = content.split(old_text).length - 1;
				if (found === 0) {
					throw new Error(
						`The text to replace is not in ${file}. Read the file again and copy the text exactly, whitespace included.`,
					);
				}
				if (found > 1 && !replace_all) {
					throw new Error(
						`The text to replace is in ${file} ${found} times. Give more of the text around it so that it is found once, or set replace_all.`,
					);
				}
				const at = content.indexOf(old_text);
				const changed = replace_all
					? content.split(old_text).join(new_text)
					: `${content.slice(0, at)}${new_text}${content.slice(at + old_text.length)}`;
				const result = await sandbox.writeFile(file, changed);
				if ("error" in result) throw new Error(result.error);
				const replaced = replace_all ? found : 1;
				return `Replaced ${replaced === 1 ? "1 place" : `${replaced} places`} in ${file}.`;
			},
		}),
		find_files: tool({
			description:
				"Lists the files whose paths match a glob, such as **/*.ts or src/**/test_*.py, sorted by path. Files git ignores are left out, and so is .git.",
			inputSchema: z.object({
				pattern: z.string().min(1).max(1_000).describe("The glob"),
				path: z
					.string()
					.max(1_000)
					.optional()
					.describe(`The directory to look in; ${SANDBOX_ROOT} when left out`),
			}),
			execute: async ({ pattern, path }) => {
				const directory = within(path ?? SANDBOX_ROOT);
				const command = `rg --files --hidden --sort path --glob '!.git' --glob ${quote(pattern)} -- ${quote(directory)}`;
				const result = await sandbox.run(command, SANDBOX_ROOT, SANDBOX_LIMITS.searchSeconds);
				return searchOutcome(result, "No files match.");
			},
		}),
		search: tool({
			description:
				"Searches files for a regular expression with ripgrep, and lists each matching line as path:line:text. Files git ignores are left out, and so is .git.",
			inputSchema: z.object({
				pattern: z.string().min(1).max(1_000).describe("The regular expression (Rust syntax)"),
				path: z
					.string()
					.max(1_000)
					.optional()
					.describe(`A file or directory to search; ${SANDBOX_ROOT} when left out`),
				glob: z
					.string()
					.max(1_000)
					.optional()
					.describe("Only files whose paths match this glob, such as *.ts"),
				ignore_case: z.boolean().optional().describe("Match regardless of case"),
			}),
			execute: async ({ pattern, path, glob, ignore_case = false }) => {
				const target = within(path ?? SANDBOX_ROOT);
				const command = [
					"rg --line-number --no-heading --color never --hidden --max-columns 500 --glob '!.git'",
					ignore_case ? "--ignore-case" : "",
					glob ? `--glob ${quote(glob)}` : "",
					`-e ${quote(pattern)} -- ${quote(target)}`,
				]
					.filter(Boolean)
					.join(" ");
				const result = await sandbox.run(command, SANDBOX_ROOT, SANDBOX_LIMITS.searchSeconds);
				return searchOutcome(result, "No line matches.");
			},
		}),
	};
	return Object.fromEntries(
		Object.entries(tools).map(([name, each]) => [name, traced(each, SANDBOX_SERVER, name, run)]),
	);
}

/** `path` under the sandbox's root, or a failure the model reads. */
function within(path: string): string {
	const plain = sandboxPath(path);
	if (plain === null) throw new Error(`${path} is outside ${SANDBOX_ROOT}, where the work is.`);
	return plain;
}

async function readText(sandbox: SandboxPort, file: string): Promise<string> {
	const result = await sandbox.readFile(file);
	if ("error" in result) throw new Error(result.error);
	return result.content;
}

function describeCommand({ exitCode, output, timedOut }: CommandResult, seconds: number): string {
	const status = timedOut
		? `It was stopped after ${seconds} seconds.`
		: `It exited with code ${exitCode}.`;
	return output.trim() === "" ? `${status} It printed nothing.` : `${status}\n\n${output}`;
}

/** The lines asked for, numbered, with where the rest is when there is more. */
function numbered(file: string, content: string, offset: number, limit: number): string {
	if (content === "") return `${file} is empty.`;
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	if (offset > lines.length) return `${file} has ${lines.length} lines; none from ${offset}.`;
	const shown = lines.slice(offset - 1, offset - 1 + limit);
	const text = shown
		.map((line, index) => {
			const cut =
				line.length > SANDBOX_LIMITS.lineLength
					? `${line.slice(0, SANDBOX_LIMITS.lineLength)}[line cut short]`
					: line;
			return `${offset + index}\t${cut}`;
		})
		.join("\n");
	const last = offset + shown.length - 1;
	return last < lines.length
		? `${text}\n\n[Lines ${offset} to ${last} of ${lines.length}; read on from ${last + 1}.]`
		: text;
}

/** ripgrep's answer: what it found, that it found nothing (exit 1), or its complaint. */
function searchOutcome(result: CommandResult, none: string): string {
	if (result.timedOut) throw new Error("The search took too long. Narrow it down.");
	if (result.exitCode === 1 && result.output.trim() === "") return none;
	if (result.exitCode !== 0) throw new Error(result.output.trim() || "The search failed.");
	return result.output;
}

/** A word for bash, quoted so that it is passed as it is. */
function quote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}
