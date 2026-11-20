import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
	type FilePort,
	fileTools,
	type ReadResult,
	SANDBOX_LIMITS,
	type SearchQuery,
	type SearchResult,
	sandboxFiles,
	sandboxTools,
	type WriteResult,
} from "../src/sandbox-tools";
import type { RunRecorder } from "../src/trace";
import { MemorySandbox } from "./fake-sandbox";

const RUN = {
	targets: { tainted: false },
	toolStarted: () => "span",
	toolEnded: () => {},
} as unknown as RunRecorder;

/** Files in memory with no machine behind them: nothing here can run a command. */
class MemoryFiles implements FilePort {
	readonly files = new Map<string, string>();
	readonly listings: { pattern: string; directory: string }[] = [];
	readonly searches: SearchQuery[] = [];
	/** What the next listings and searches answer, in order; then each finds nothing. */
	readonly answers: SearchResult[] = [];

	async readFile(path: string): Promise<ReadResult> {
		const content = this.files.get(path);
		return content === undefined ? { error: `${path} does not exist.` } : { content };
	}

	async writeFile(path: string, content: string): Promise<WriteResult> {
		this.files.set(path, content);
		return { written: new TextEncoder().encode(content).length };
	}

	async findFiles(pattern: string, directory: string): Promise<SearchResult> {
		this.listings.push({ pattern, directory });
		return this.answers.shift() ?? { found: null };
	}

	async search(query: SearchQuery): Promise<SearchResult> {
		this.searches.push(query);
		return this.answers.shift() ?? { found: null };
	}
}

/** Calls one of `tools` as the model would. */
function calling(tools: ToolSet) {
	return (name: string, input: object) => {
		const execute = tools[name]?.execute as
			| ((input: object, options: { toolCallId: string; messages: [] }) => Promise<unknown>)
			| undefined;
		if (!execute) throw new Error(`No tool ${name}`);
		return execute(input, { toolCallId: "call-1", messages: [] });
	};
}

/** The tools for files over `files`. */
function toolbox(files: FilePort) {
	const tools = fileTools(files, RUN);
	return { tools, call: calling(tools) };
}

describe("the tools for files", () => {
	it("are the sandbox's six without run_command, in the order the sandbox gives them", () => {
		const { tools } = toolbox(new MemoryFiles());
		const names = ["read_file", "write_file", "edit_file", "find_files", "search"];
		expect(Object.keys(tools)).toEqual(names);
		expect(Object.keys(sandboxTools(new MemorySandbox(), RUN))).toEqual(["run_command", ...names]);
	});

	it("say to the model what the sandbox's say, word for word", () => {
		const { tools } = toolbox(new MemoryFiles());
		const sandbox = sandboxTools(new MemorySandbox(), RUN);
		for (const [name, each] of Object.entries(tools)) {
			expect(each.description).toBe(sandbox[name]?.description);
		}
	});

	it("read, write and edit files that no machine holds", async () => {
		const files = new MemoryFiles();
		const { call } = toolbox(files);
		expect(await call("write_file", { path: "docs/a.md", content: "# One\n\ntwo\n" })).toBe(
			"Wrote 11 bytes to /workspace/docs/a.md.",
		);
		expect(await call("read_file", { path: "docs/a.md" })).toBe("1\t# One\n2\t\n3\ttwo");
		expect(await call("edit_file", { path: "docs/a.md", old_text: "two", new_text: "2" })).toBe(
			"Replaced 1 place in /workspace/docs/a.md.",
		);
		expect(files.files.get("/workspace/docs/a.md")).toBe("# One\n\n2\n");
		await expect(call("read_file", { path: "docs/missing.md" })).rejects.toThrow(
			"/workspace/docs/missing.md does not exist.",
		);
		await expect(call("write_file", { path: "/etc/passwd", content: "" })).rejects.toThrow(
			"/etc/passwd is outside /workspace",
		);
	});

	it("keep both edits of one file made in one step, whose calls run concurrently", async () => {
		const files = new MemoryFiles();
		const { call } = toolbox(files);
		await call("write_file", { path: "docs/a.md", content: "one\ntwo\nthree\n" });
		// Without a queue per path the second call reads before the first has written, and its
		// write takes the first's place.
		const [first, second] = await Promise.all([
			call("edit_file", { path: "docs/a.md", old_text: "one", new_text: "1" }),
			call("edit_file", { path: "docs/a.md", old_text: "three", new_text: "3" }),
		]);
		expect(first).toBe("Replaced 1 place in /workspace/docs/a.md.");
		expect(second).toBe("Replaced 1 place in /workspace/docs/a.md.");
		expect(files.files.get("/workspace/docs/a.md")).toBe("1\ntwo\n3\n");
	});

	it("bound numbered reads by UTF-8 bytes including the continuation hint", async () => {
		const files = new MemoryFiles();
		const { call } = toolbox(files);
		const wide = "🙂".repeat(1_000);
		const firstFour = Array.from({ length: 4 }, (_, index) => `${index + 1}\t${wide}`).join("\n");
		const hint = "\n\n[Lines 1 to 5 of 6; read on from 6.]";
		const fifthLength =
			SANDBOX_LIMITS.readBytes - new TextEncoder().encode(`${firstFour}\n5\t${hint}`).length;
		const fifth = "x".repeat(fifthLength);
		const tail = "t".repeat(128);
		files.files.set("/workspace/wide.txt", [wide, wide, wide, wide, fifth, tail].join("\n"));

		const page = await call("read_file", { path: "wide.txt" });
		expect(page).toBe(`${firstFour}\n5\t${fifth}${hint}`);
		expect(new TextEncoder().encode(page as string)).toHaveLength(SANDBOX_LIMITS.readBytes);
		expect(await call("read_file", { path: "wide.txt", offset: 6 })).toBe(`6\t${tail}`);

		files.files.set("/workspace/wide.txt", [wide, wide, wide, wide, `${fifth}x`, tail].join("\n"));
		const shorter = await call("read_file", { path: "wide.txt" });
		expect(shorter).toBe(`${firstFour}\n\n[Lines 1 to 4 of 6; read on from 5.]`);
		expect(new TextEncoder().encode(shorter as string).length).toBeLessThanOrEqual(
			SANDBOX_LIMITS.readBytes,
		);
		expect(await call("read_file", { path: "wide.txt", offset: 5 })).toBe(
			`5\t${fifth}x\n6\t${tail}`,
		);
	});

	it("keep explicit line limits, offsets, and complete surrogate pairs at a line cut", async () => {
		const files = new MemoryFiles();
		const { call } = toolbox(files);
		files.files.set("/workspace/lines.txt", `first\n${"a".repeat(1_999)}🙂after\nthird`);

		expect(await call("read_file", { path: "lines.txt", offset: 2, limit: 1 })).toBe(
			`2\t${"a".repeat(1_999)}[line cut short]\n\n[Lines 2 to 2 of 3; read on from 3.]`,
		);
		expect(await call("read_file", { path: "lines.txt", offset: 3 })).toBe("3\tthird");
		expect(await call("read_file", { path: "lines.txt", offset: 4 })).toBe(
			"/workspace/lines.txt has 3 lines; none from 4.",
		);
	});

	it("ask the port to list and to search, with plain paths, and answer with what it found", async () => {
		const files = new MemoryFiles();
		const { call } = toolbox(files);
		files.answers.push(
			{ found: "/workspace/docs/a.md\n" },
			{ found: null },
			{ found: "/workspace/docs/a.md:1:# One\n" },
			{ found: null },
			{ error: "That would read too many files. Give a path." },
		);

		expect(await call("find_files", { pattern: "**/*.md" })).toBe("/workspace/docs/a.md\n");
		expect(await call("find_files", { pattern: "*.rs", path: "./docs/../src" })).toBe(
			"No files match.",
		);
		expect(await call("search", { pattern: "One", path: "docs" })).toBe(
			"/workspace/docs/a.md:1:# One\n",
		);
		expect(await call("search", { pattern: "it's", glob: "*.md", ignore_case: true })).toBe(
			"No line matches.",
		);
		await expect(call("search", { pattern: "x" })).rejects.toThrow("That would read too many");

		expect(files.listings).toEqual([
			{ pattern: "**/*.md", directory: "/workspace" },
			{ pattern: "*.rs", directory: "/workspace/src" },
		]);
		expect(files.searches).toEqual([
			{ pattern: "One", path: "/workspace/docs", glob: undefined, ignoreCase: false },
			{ pattern: "it's", path: "/workspace", glob: "*.md", ignoreCase: true },
			{ pattern: "x", path: "/workspace", glob: undefined, ignoreCase: false },
		]);

		// A path that leads out of the work is refused before the port is asked.
		await expect(call("find_files", { pattern: "*", path: "/etc" })).rejects.toThrow(
			"/etc is outside /workspace",
		);
		await expect(call("search", { pattern: "root", path: "../etc" })).rejects.toThrow(
			"../etc is outside /workspace",
		);
		expect(files.listings).toHaveLength(2);
		expect(files.searches).toHaveLength(3);
	});
});

describe("a sandbox's files", () => {
	it("are read and written by the sandbox, and listed and searched by ripgrep in it", async () => {
		const sandbox = new MemorySandbox();
		const files = sandboxFiles(sandbox);
		expect(await files.writeFile("/workspace/a.txt", "a\n")).toEqual({ written: 2 });
		expect(await files.readFile("/workspace/a.txt")).toEqual({ content: "a\n" });
		expect(await files.readFile("/workspace/b.txt")).toEqual({
			error: "/workspace/b.txt does not exist.",
		});

		sandbox.answers.push(
			{ exitCode: 0, output: "/workspace/a.txt\n", timedOut: false },
			{ exitCode: 0, output: "/workspace/a.txt:1:a\n", timedOut: false },
		);
		expect(await files.findFiles("*.txt", "/workspace")).toEqual({ found: "/workspace/a.txt\n" });
		expect(
			await files.search({ pattern: "a", path: "/workspace/a.txt", ignoreCase: false }),
		).toEqual({ found: "/workspace/a.txt:1:a\n" });
		expect(sandbox.commands).toEqual([
			{
				command: "rg --files --hidden --sort path --glob '!.git' --glob '*.txt' -- '/workspace'",
				cwd: "/workspace",
				timeoutSeconds: 60,
			},
			{
				command:
					"rg --line-number --no-heading --color never --hidden --max-columns 500 --glob '!.git' -e 'a' -- '/workspace/a.txt'",
				cwd: "/workspace",
				timeoutSeconds: 60,
			},
		]);
	});

	it("say what ripgrep's exit means: nothing found, a complaint, or out of time", async () => {
		const sandbox = new MemorySandbox();
		const files = sandboxFiles(sandbox);
		sandbox.answers.push(
			{ exitCode: 1, output: "\n", timedOut: false },
			{ exitCode: 2, output: " regex parse error\n", timedOut: false },
			{ exitCode: 2, output: "", timedOut: false },
			{ exitCode: 124, output: "/workspace/a.txt\n", timedOut: true },
			{ exitCode: 0, output: "", timedOut: false },
		);
		const query = { pattern: "(", path: "/workspace", ignoreCase: false };
		expect(await files.search(query)).toEqual({ found: null });
		expect(await files.search(query)).toEqual({ error: "regex parse error" });
		expect(await files.search(query)).toEqual({ error: "The search failed." });
		expect(await files.findFiles("*", "/workspace")).toEqual({
			error: "The search took too long. Narrow it down.",
		});
		// Ripgrep does not exit with 0 and print nothing, but a command that did is passed on as it is.
		expect(await files.findFiles("*", "/workspace")).toEqual({ found: "" });
	});

	it("reach the model through the sandbox's tools as they did before the port", async () => {
		const sandbox = new MemorySandbox();
		const call = calling(sandboxTools(sandbox, RUN));
		sandbox.answers.push(
			{ exitCode: 124, output: "", timedOut: true },
			{ exitCode: 2, output: "", timedOut: false },
			{ exitCode: 0, output: "", timedOut: false },
		);
		await expect(call("search", { pattern: "x" })).rejects.toThrow(
			"The search took too long. Narrow it down.",
		);
		await expect(call("find_files", { pattern: "*" })).rejects.toThrow("The search failed.");
		expect(await call("find_files", { pattern: "*" })).toBe("");
	});
});
