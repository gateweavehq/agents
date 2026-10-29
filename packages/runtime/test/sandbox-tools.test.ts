import { describe, expect, it } from "vitest";
import { decideOutbound } from "../src/outbound";
import { clipOutput } from "../src/output";
import { SANDBOX_LIMITS, sandboxPath, sandboxTools } from "../src/sandbox-tools";
import type { RunRecorder } from "../src/trace";
import { MemorySandbox } from "./fake-sandbox";

/** The sandbox's tools over files in memory, each called as the model would call it. */
function toolbox() {
	const sandbox = new MemorySandbox();
	const run = { toolStarted: () => "span", toolEnded: () => {} } as unknown as RunRecorder;
	const tools = sandboxTools(sandbox, run);
	const call = (name: string, input: object) => {
		const execute = tools[name]?.execute as
			| ((input: object, options: { toolCallId: string; messages: [] }) => Promise<unknown>)
			| undefined;
		if (!execute) throw new Error(`No tool ${name}`);
		return execute(input, { toolCallId: "call-1", messages: [] });
	};
	return { sandbox, tools, call };
}

describe("sandbox paths", () => {
	it("start at /workspace and stay under it", () => {
		expect(sandboxPath("src/index.ts")).toBe("/workspace/src/index.ts");
		expect(sandboxPath("./a/../b//c.txt")).toBe("/workspace/b/c.txt");
		expect(sandboxPath("/workspace")).toBe("/workspace");
		expect(sandboxPath("/workspace/repo/")).toBe("/workspace/repo");
		expect(sandboxPath("../etc/passwd")).toBeNull();
		expect(sandboxPath("/etc/passwd")).toBeNull();
		expect(sandboxPath("/workspaces/other")).toBeNull();
		expect(sandboxPath("/../../workspace/x")).toBeNull();
	});
});

describe("sandbox tools", () => {
	it("are the six a turn with a sandbox gets", () => {
		expect(Object.keys(toolbox().tools).sort()).toEqual([
			"edit_file",
			"find_files",
			"read_file",
			"run_command",
			"search",
			"write_file",
		]);
	});

	it("run a command in /workspace with the default timeout, and say how it went", async () => {
		const { sandbox, call } = toolbox();
		sandbox.answers.push(
			{ exitCode: 0, output: "3 passed\n", timedOut: false },
			{ exitCode: 2, output: "", timedOut: false },
			{ exitCode: 124, output: "still going\n", timedOut: true },
		);

		expect(await call("run_command", { command: "npm test" })).toBe(
			"It exited with code 0.\n\n3 passed\n",
		);
		expect(await call("run_command", { command: "false", cwd: "repo" })).toBe(
			"It exited with code 2. It printed nothing.",
		);
		expect(await call("run_command", { command: "sleep 99", timeout_seconds: 5 })).toBe(
			"It was stopped after 5 seconds.\n\nstill going\n",
		);
		expect(sandbox.commands).toEqual([
			{ command: "npm test", cwd: "/workspace", timeoutSeconds: SANDBOX_LIMITS.commandSeconds },
			{ command: "false", cwd: "/workspace/repo", timeoutSeconds: SANDBOX_LIMITS.commandSeconds },
			{ command: "sleep 99", cwd: "/workspace", timeoutSeconds: 5 },
		]);
		await expect(call("run_command", { command: "ls", cwd: "/" })).rejects.toThrow(
			"/ is outside /workspace",
		);
	});

	it("write a file, read it back numbered, and page through a long one", async () => {
		const { sandbox, call } = toolbox();
		expect(await call("write_file", { path: "notes/a.txt", content: "one\ntwo\nthree\n" })).toBe(
			"Wrote 14 bytes to /workspace/notes/a.txt.",
		);
		expect(sandbox.files.get("/workspace/notes/a.txt")).toBe("one\ntwo\nthree\n");
		expect(await call("read_file", { path: "/workspace/notes/a.txt" })).toBe(
			"1\tone\n2\ttwo\n3\tthree",
		);
		expect(await call("read_file", { path: "notes/a.txt", offset: 2, limit: 1 })).toBe(
			"2\ttwo\n\n[Lines 2 to 2 of 3; read on from 3.]",
		);
		expect(await call("read_file", { path: "notes/a.txt", offset: 9 })).toBe(
			"/workspace/notes/a.txt has 3 lines; none from 9.",
		);

		sandbox.files.set("/workspace/long.txt", "x".repeat(SANDBOX_LIMITS.lineLength + 5));
		expect(await call("read_file", { path: "long.txt" })).toBe(
			`1\t${"x".repeat(SANDBOX_LIMITS.lineLength)}[line cut short]`,
		);
		sandbox.files.set("/workspace/empty.txt", "");
		expect(await call("read_file", { path: "empty.txt" })).toBe("/workspace/empty.txt is empty.");
		await expect(call("read_file", { path: "missing.txt" })).rejects.toThrow(
			"/workspace/missing.txt does not exist.",
		);
	});

	it("edit a file only where the old text is found once, unless told to replace all", async () => {
		const { sandbox, call } = toolbox();
		sandbox.files.set("/workspace/a.ts", "let a = 1;\nlet b = 1;\n");

		await expect(
			call("edit_file", { path: "a.ts", old_text: "= 1", new_text: "= 2" }),
		).rejects.toThrow("is in /workspace/a.ts 2 times");
		await expect(
			call("edit_file", { path: "a.ts", old_text: "let c", new_text: "let d" }),
		).rejects.toThrow("is not in /workspace/a.ts");
		await expect(
			call("edit_file", { path: "a.ts", old_text: "let", new_text: "let" }),
		).rejects.toThrow("the same as the old");
		expect(sandbox.files.get("/workspace/a.ts")).toBe("let a = 1;\nlet b = 1;\n");

		expect(
			await call("edit_file", { path: "a.ts", old_text: "let b = 1", new_text: "const b = $&" }),
		).toBe("Replaced 1 place in /workspace/a.ts.");
		// The new text is taken as it is: `$&` is not a replacement pattern.
		expect(sandbox.files.get("/workspace/a.ts")).toBe("let a = 1;\nconst b = $&;\n");
		expect(
			await call("edit_file", { path: "a.ts", old_text: ";", new_text: "", replace_all: true }),
		).toBe("Replaced 2 places in /workspace/a.ts.");
		expect(sandbox.files.get("/workspace/a.ts")).toBe("let a = 1\nconst b = $&\n");
	});

	it("find files and search with ripgrep, quoting what the model gave", async () => {
		const { sandbox, call } = toolbox();
		sandbox.answers.push(
			{ exitCode: 0, output: "/workspace/src/a.ts\n", timedOut: false },
			{ exitCode: 1, output: "", timedOut: false },
			{ exitCode: 2, output: "regex parse error\n", timedOut: false },
		);

		expect(await call("find_files", { pattern: "**/*.ts" })).toBe("/workspace/src/a.ts\n");
		expect(await call("search", { pattern: "it's", glob: "*.md", ignore_case: true })).toBe(
			"No line matches.",
		);
		await expect(call("search", { pattern: "(" })).rejects.toThrow("regex parse error");
		expect(sandbox.commands.map((command) => command.command)).toEqual([
			"rg --files --hidden --sort path --glob '!.git' --glob '**/*.ts' -- '/workspace'",
			`rg --line-number --no-heading --color never --hidden --max-columns 500 --glob '!.git' --ignore-case --glob '*.md' -e 'it'\\''s' -- '/workspace'`,
			"rg --line-number --no-heading --color never --hidden --max-columns 500 --glob '!.git' -e '(' -- '/workspace'",
		]);
		for (const command of sandbox.commands) {
			expect(command.timeoutSeconds).toBe(SANDBOX_LIMITS.searchSeconds);
		}
	});
});

describe("a command's output", () => {
	const stream = (...chunks: string[]) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});

	it("is kept whole when it fits", async () => {
		expect(await clipOutput(stream("hello ", "world"), 20)).toEqual({
			text: "hello world",
			omitted: 0,
		});
		expect(await clipOutput(null)).toEqual({ text: "", omitted: 0 });
	});

	it("keeps its start and end when it does not, across chunks", async () => {
		const clipped = await clipOutput(stream("abcdefgh", "ijklmnop", "qrstuvwxyz"), 10);
		expect(clipped).toEqual({
			text: "abcde\n\n[16 bytes of output left out here]\n\nvwxyz",
			omitted: 16,
		});
	});
});

describe("a sandbox's way out", () => {
	const decide = (method: string, url: string) => decideOutbound(method, new URL(url));

	it("lets package downloads through", () => {
		expect(decide("GET", "https://registry.npmjs.org/zod")).toEqual({ allow: true });
		expect(decide("HEAD", "https://files.pythonhosted.org/packages/x.whl")).toEqual({
			allow: true,
		});
		expect(decide("GET", "https://proxy.golang.org/golang.org/x/text/@v/list")).toEqual({
			allow: true,
		});
	});

	it("refuses everything else, saying why", () => {
		expect(decide("PUT", "https://registry.npmjs.org/my-package")).toEqual({
			allow: false,
			reason: "registry.npmjs.org takes only downloads from this sandbox",
		});
		expect(decide("GET", "http://registry.npmjs.org/zod")).toEqual({
			allow: false,
			reason: "registry.npmjs.org is reachable only over HTTPS",
		});
		for (const url of [
			"https://example.com/",
			"https://api.anthropic.com/v1/messages",
			"https://registry.npmjs.org.evil.dev/zod",
			"https://registry.npmjs.org:8443/zod",
			"https://github.com/gateweavehq/agents.git/info/refs",
		]) {
			expect(decide("GET", url)).toMatchObject({ allow: false });
		}
	});
});
