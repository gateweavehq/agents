/**
 * The tools of a turn with a sandbox: running commands, and reading, writing, editing, finding and
 * searching files on the conversation's own Linux machine (`./sandbox.ts`). They reach it through
 * `SandboxPort`, so the tests can stand a fake in for the container. Each call joins the trace
 * like an MCP server's, with its sizes and never its content.
 *
 * Only `run_command` needs a machine. The five tools for files ask for a `FilePort`: files read
 * and written whole, listed by a glob and searched. A sandbox answers it through `sandboxFiles`,
 * with ripgrep for the last two, so files kept some other way can stand behind the same tools
 * (AGT-122): `FileStore` in `./file-store.ts` keeps a repository's files in the conversation's
 * own SQLite. What a port answers is written down at `SearchResult`, and what it says of itself
 * to the model at `FileWords`.
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
	/** Bytes of output the bound left out; absent when nothing was left out. */
	omitted?: number;
}

/** A file's text, or why it could not be read, in words the model reads. */
export type ReadResult = { content: string } | { error: string };

/** How many bytes went into the file, or why none did. */
export type WriteResult = { written: number } | { error: string };

/** That the file is gone, or why it is not, in words the model reads. */
export type DeleteResult = { deleted: true } | { error: string };

/**
 * What a listing or a search found, as the text the model reads; or why it could not look, in
 * words the model reads.
 *
 * The text is in ripgrep's format, and the format is part of the port. A sandbox's answer is
 * ripgrep's own output, clipped by the sandbox as any command's is, which cannot be taken apart
 * into results and put together again byte for byte; so every port writes the same text rather
 * than hand over results for the tools to format:
 *
 * - One result to a line, each line ended by a newline, the last one too.
 * - A listing's line is the file's absolute path. Lines are sorted by path, one part of the path
 *   at a time and each part by its bytes, so `src/a/x.ts` comes before `src/a.ts` and `B.ts`
 *   before `a.ts`.
 * - A search's line is `path:line:text`: the absolute path, the line's number from 1, and the
 *   line without its newline; a carriage return before the newline stays. When `query.path` is
 *   a file and not a directory, the path and its colon are left out (`line:text`), as ripgrep
 *   leaves them out for one file. A matching line of more than 500 bytes, counted with the
 *   newline that ends it, is given as `[Omitted long matching line]` in place of its text. A
 *   file named itself is searched, and listed, whatever the glob. A byte order mark at a file's start is
 *   not part of its first line. The files come in no promised order from a sandbox, where
 *   ripgrep searches several at once, and sorted like a listing from `FileStore`.
 * - Text longer than `OUTPUT_LIMIT` bytes keeps its start and its end, with how many bytes were
 *   left out between them, as a command's output does (`./output.ts`).
 * - `found` is null when nothing matches. `FileStore` never answers an empty string. A sandbox's
 *   port can: it passes on what its command printed, so a command that exits with 0 and prints
 *   nothing comes back as `""`, which the tools then answer with as it is. ripgrep itself exits
 *   with 1 when it finds nothing, which is null here.
 */
export type SearchResult = { found: string | null } | { error: string };

/**
 * What `find_files` and `search` tell the model of the files behind them. The port's owner
 * writes them, since only it knows its rules: which files it leaves out, and what a pattern is.
 */
export interface FileWords {
	/** The description of `find_files`. */
	findFiles: string;
	/** The description of `search`. */
	search: string;
	/** What `search`'s pattern is: a regular expression, or text as it is written. */
	pattern: string;
}

/** What `search` looks for, and where. */
export interface SearchQuery {
	/** The pattern, as the model gave it. */
	pattern: string;
	/** The file or directory to search. */
	path: string;
	/** Only files whose paths match this glob, when there is one. */
	glob?: string;
	ignoreCase: boolean;
}

/** What the tools need of a sandbox. `RunnerSandbox` is the real one. */
export interface SandboxPort {
	/** Runs a bash command line in `cwd`, stopped after `timeoutSeconds`. */
	run(command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult>;
	readFile(path: string): Promise<ReadResult>;
	/** Writes the file, making the directories it needs. */
	writeFile(path: string, content: string): Promise<WriteResult>;
}

/**
 * What the tools for files need: a sandbox's two calls for whole files, and a listing and a search
 * in place of `run`. Paths are absolute and plain, as `sandboxPath` leaves them.
 */
export interface FilePort {
	readFile(path: string): Promise<ReadResult>;
	/** Writes the file, making the directories it needs. */
	writeFile(path: string, content: string): Promise<WriteResult>;
	/** The files under `directory` whose paths match the glob, one to a line, sorted by path. */
	findFiles(pattern: string, directory: string): Promise<SearchResult>;
	/** The lines that match, each as path:line:text. */
	search(query: SearchQuery): Promise<SearchResult>;
	/** What the listing and the search say of themselves; a sandbox's words when left out. */
	readonly words?: FileWords;
}

/**
 * Files that can also be taken away one at a time. A sandbox's can, with `rm`, though its model
 * has `run_command` for that and is offered no tool for it; `delete_file` is for files that no
 * command reaches (`deletingFileTools`).
 */
export interface DeletingFilePort extends FilePort {
	/** Deletes the file. A directory is not deleted this way. */
	deleteFile(path: string): Promise<DeleteResult>;
}

/** What a sandbox's listing and search say: ripgrep's rules. */
export const SANDBOX_FILE_WORDS: FileWords = {
	findFiles:
		"Lists the files whose paths match a glob, such as **/*.ts or src/**/test_*.py, sorted by path. Files git ignores are left out, and so is .git.",
	search:
		"Searches files for a regular expression with ripgrep, and lists each matching line as path:line:text. Files git ignores are left out, and so is .git.",
	pattern: "The regular expression (Rust syntax)",
};

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

/** The sandbox's tools for one turn, traced in `run`: `run_command`, then the tools for files. */
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
	};
	return { ...tracedTools(tools, run), ...fileTools(sandboxFiles(sandbox), run) };
}

/** The tools that read, write, edit, find and search files, traced in `run`. */
export function fileTools(files: FilePort, run: RunRecorder): ToolSet {
	const words = files.words ?? SANDBOX_FILE_WORDS;
	const tools: ToolSet = {
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
				return numbered(file, await readText(files, file), offset, limit);
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
				const result = await files.writeFile(file, content);
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
				const content = await readText(files, file);
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
				const result = await files.writeFile(file, changed);
				if ("error" in result) throw new Error(result.error);
				const replaced = replace_all ? found : 1;
				return `Replaced ${replaced === 1 ? "1 place" : `${replaced} places`} in ${file}.`;
			},
		}),
		find_files: tool({
			description: words.findFiles,
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
				return foundOr("No files match.", await files.findFiles(pattern, directory));
			},
		}),
		search: tool({
			description: words.search,
			inputSchema: z.object({
				pattern: z.string().min(1).max(1_000).describe(words.pattern),
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
				const query = { pattern, path: target, glob, ignoreCase: ignore_case };
				return foundOr("No line matches.", await files.search(query));
			},
		}),
	};
	return tracedTools(tools, run);
}

/**
 * The tools for files with `delete_file` after them: for files no command reaches, where a file
 * goes only this way. A sandbox's turn is not offered it; there `run_command` deletes.
 */
export function deletingFileTools(files: DeletingFilePort, run: RunRecorder): ToolSet {
	const tools: ToolSet = {
		delete_file: tool({
			description:
				"Deletes a file. A directory is gone once the files in it are; it is not deleted by its own path.",
			inputSchema: z.object({
				path: z.string().min(1).max(1_000).describe(`Absolute, or from ${SANDBOX_ROOT}`),
			}),
			execute: async ({ path }) => {
				const file = within(path);
				const result = await files.deleteFile(file);
				if ("error" in result) throw new Error(result.error);
				return `Deleted ${file}.`;
			},
		}),
	};
	return { ...fileTools(files, run), ...tracedTools(tools, run) };
}

/**
 * A sandbox's files as the tools for files reach them. The files are on its disk, so it lists and
 * searches them with ripgrep, and deletes one with `rm`, each run as a command.
 */
export function sandboxFiles(sandbox: SandboxPort): DeletingFilePort {
	const ripgrep = async (command: string) =>
		ripgrepOutcome(await sandbox.run(command, SANDBOX_ROOT, SANDBOX_LIMITS.searchSeconds));
	return {
		words: SANDBOX_FILE_WORDS,
		readFile: (path) => sandbox.readFile(path),
		writeFile: (path, content) => sandbox.writeFile(path, content),
		deleteFile: async (path) => {
			const removed = await sandbox.run(
				`rm -- ${quote(path)}`,
				SANDBOX_ROOT,
				SANDBOX_LIMITS.searchSeconds,
			);
			if (removed.timedOut) return { error: `${path} was not deleted in time.` };
			if (removed.exitCode === 0) return { deleted: true };
			return { error: removed.output.trim() || `${path} could not be deleted.` };
		},
		findFiles: (pattern, directory) =>
			ripgrep(
				`rg --files --hidden --sort path --glob '!.git' --glob ${quote(pattern)} -- ${quote(directory)}`,
			),
		search: ({ pattern, path, glob, ignoreCase }) =>
			ripgrep(
				[
					"rg --line-number --no-heading --color never --hidden --max-columns 500 --glob '!.git'",
					ignoreCase ? "--ignore-case" : "",
					glob ? `--glob ${quote(glob)}` : "",
					`-e ${quote(pattern)} -- ${quote(path)}`,
				]
					.filter(Boolean)
					.join(" "),
			),
	};
}

/** Each tool as the trace records it, under the sandbox's name, with the reason a call failed. */
function tracedTools(tools: ToolSet, run: RunRecorder): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, each]) => [
			name,
			traced(each, SANDBOX_SERVER, name, run, { showErrors: true }),
		]),
	);
}

/** `path` under the sandbox's root, or a failure the model reads. */
function within(path: string): string {
	const plain = sandboxPath(path);
	if (plain === null) throw new Error(`${path} is outside ${SANDBOX_ROOT}, where the work is.`);
	return plain;
}

async function readText(files: FilePort, file: string): Promise<string> {
	const result = await files.readFile(file);
	if ("error" in result) throw new Error(result.error);
	return result.content;
}

/** What a listing or a search answers the model: its lines, `none` for none, or its failure. */
function foundOr(none: string, result: SearchResult): string {
	if ("error" in result) throw new Error(result.error);
	return result.found ?? none;
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
function ripgrepOutcome(result: CommandResult): SearchResult {
	if (result.timedOut) return { error: "The search took too long. Narrow it down." };
	if (result.exitCode === 1 && result.output.trim() === "") return { found: null };
	if (result.exitCode !== 0) return { error: result.output.trim() || "The search failed." };
	return { found: result.output };
}

/** A word for bash, quoted so that it is passed as it is. */
function quote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}
