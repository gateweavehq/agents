import { GitHubError } from "@gateweave/agents-github";
import type { PullRequestOutcome } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import { repositoryNote, withCheckout } from "../src/checkout";
import {
	checkPush,
	decideOutbound,
	type PushWindow,
	pushedRefs,
	withGitHubToken,
} from "../src/outbound";
import { clipOutput } from "../src/output";
import { type PullRequestPort, pullRequestTools } from "../src/pull-requests";
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

	describe("to GitHub", () => {
		const repository = { owner: "acme", name: "Site" };
		const git = (method: string, url: string, push: PushWindow | null = null) =>
			decideOutbound(method, new URL(url), { repository, push });
		const only = {
			allow: false,
			reason: "github.com is reachable from this sandbox only to fetch acme/Site",
		};

		it("lets git fetch the agent's repository, with a token the Worker adds", () => {
			const allowed = { allow: true, credentials: "read" };
			expect(
				git("GET", "https://github.com/acme/site.git/info/refs?service=git-upload-pack"),
			).toEqual(allowed);
			expect(git("POST", "https://github.com/ACME/Site/git-upload-pack")).toEqual(allowed);
		});

		it("lets the push open_pull_request makes through, with a token that writes", () => {
			const push = { branch: "gateweave/c-1", from: null };
			expect(
				git("GET", "https://github.com/acme/site.git/info/refs?service=git-receive-pack", push),
			).toEqual({ allow: true, credentials: "write" });
			// The pack goes out only once the Worker has checked what it updates.
			expect(git("POST", "https://github.com/acme/site.git/git-receive-pack", push)).toEqual({
				allow: true,
				credentials: "write",
				push,
			});
			expect(git("GET", "https://github.com/acme/site.git/git-receive-pack", push)).toEqual(only);
			expect(git("POST", "https://github.com/other/site.git/git-receive-pack", push)).toEqual({
				allow: false,
				reason: "github.com is reachable from this sandbox only to fetch acme/Site",
			});
		});

		it("refuses pushing, other repositories and anything else on github.com", () => {
			const push = {
				allow: false,
				reason: "This sandbox cannot push to github.com: open_pull_request pushes the work",
			};
			expect(
				git("GET", "https://github.com/acme/site.git/info/refs?service=git-receive-pack"),
			).toEqual(push);
			expect(git("POST", "https://github.com/acme/site.git/git-receive-pack")).toEqual(push);
			for (const url of [
				"https://github.com/acme/site-other.git/info/refs?service=git-upload-pack",
				"https://github.com/acme/siteother/git-upload-pack",
				"https://github.com/other/site.git/info/refs?service=git-upload-pack",
				"https://github.com/acme/site/archive/refs/heads/main.zip",
				"https://github.com/acme/site/..%2Fother/info/refs?service=git-upload-pack",
				"https://github.com/acme/site.git/info/refs",
			]) {
				expect(git("GET", url)).toEqual(only);
			}
			expect(git("GET", "https://github.com/acme/site.git/git-upload-pack")).toEqual(only);
			expect(git("GET", "https://api.github.com/repos/acme/site")).toMatchObject({
				allow: false,
			});
			expect(git("GET", "https://github.com:8443/acme/site.git/info/refs")).toMatchObject({
				allow: false,
			});
			expect(git("GET", "http://github.com/acme/site.git/info/refs")).toEqual({
				allow: false,
				reason: "github.com is reachable only over HTTPS",
			});
		});

		it("is closed to a sandbox whose agent has no repository", () => {
			expect(
				decide("GET", "https://github.com/acme/site.git/info/refs?service=git-upload-pack"),
			).toEqual({
				allow: false,
				reason: "github.com is not reachable from this sandbox: its agent has no repository",
			});
		});

		it("reads the ref updates a push starts with", () => {
			const updates = pushedRefs(
				pushBody([
					`${ZERO} ${sha("b")} refs/heads/gateweave/c-1\0 report-status side-band-64k agent=git/2.47.3`,
					`${sha("c")} ${sha("d")} refs/heads/main`,
				]),
			);
			expect(updates).toEqual([
				{ ref: "refs/heads/gateweave/c-1", from: ZERO, to: sha("b") },
				{ ref: "refs/heads/main", from: sha("c"), to: sha("d") },
			]);
			// Anything else before the pack, or a body that is not a push's, has no updates to trust.
			const certificate = pushBody(["push-cert\0 report-status", "certificate version 0.1"]);
			for (const body of [
				certificate,
				pushBody([]),
				new TextEncoder().encode("0032want "),
				new TextEncoder().encode("zzzz"),
				new TextEncoder().encode(`00a0${ZERO} ${sha("b")} refs/heads/x`),
			]) {
				expect(pushedRefs(body)).toBeNull();
			}
		});

		it("lets a push make or move the conversation's branch, and nothing else", () => {
			const branch = "gateweave/c-1";
			const update = (ref: string, from: string, to: string) => [{ ref, from, to }];
			const first: PushWindow = { branch, from: null };
			const again: PushWindow = { branch, from: sha("b") };
			expect(checkPush(update(`refs/heads/${branch}`, ZERO, sha("b")), first)).toBeNull();
			expect(checkPush(update(`refs/heads/${branch}`, sha("b"), sha("c")), again)).toBeNull();
			// A branch GitHub deleted, as a merged pull request's, is made again.
			expect(checkPush(update(`refs/heads/${branch}`, ZERO, sha("c")), again)).toBeNull();

			const only = "This sandbox pushes only to gateweave/c-1";
			expect(checkPush(update("refs/heads/main", sha("a"), sha("b")), first)).toBe(only);
			expect(checkPush(update(`refs/tags/${branch}`, ZERO, sha("b")), first)).toBe(only);
			expect(checkPush(null, first)).toBe(only);
			expect(
				checkPush(
					[
						...update(`refs/heads/${branch}`, ZERO, sha("b")),
						...update("refs/heads/x", ZERO, sha("b")),
					],
					first,
				),
			).toBe(only);
			expect(checkPush(update(`refs/heads/${branch}`, sha("b"), ZERO), again)).toBe(
				"This sandbox does not delete gateweave/c-1",
			);
			const theirs =
				"Someone else pushed to gateweave/c-1, and this sandbox does not push over their commits";
			expect(checkPush(update(`refs/heads/${branch}`, sha("e"), sha("c")), again)).toBe(theirs);
			expect(checkPush(update(`refs/heads/${branch}`, sha("e"), sha("c")), first)).toBe(theirs);
		});

		it("carries the token as GitHub takes it, and the request as git sent it", async () => {
			const sent = new Request("https://github.com/acme/site.git/git-upload-pack", {
				method: "POST",
				headers: { "content-type": "application/x-git-upload-pack-request" },
				body: "0032want",
			});
			const outgoing = withGitHubToken(sent, "ghs_scoped");
			expect(outgoing.method).toBe("POST");
			expect(outgoing.url).toBe(sent.url);
			expect(outgoing.headers.get("content-type")).toBe("application/x-git-upload-pack-request");
			expect(atob((outgoing.headers.get("authorization") ?? "").replace(/^Basic /, ""))).toBe(
				"x-access-token:ghs_scoped",
			);
			expect(await outgoing.text()).toBe("0032want");
		});
	});
});

const ZERO = "0".repeat(40);

function sha(letter: string): string {
	return letter.repeat(40);
}

/** A push's request as git sends it: each command a pkt-line, a flush, then the pack. */
function pushBody(commands: string[]): Uint8Array {
	const lines = commands.map((command) => {
		const line = `${command}\n`;
		const length = new TextEncoder().encode(line).length + 4;
		return `${length.toString(16).padStart(4, "0")}${line}`;
	});
	return new TextEncoder().encode(`${lines.join("")}0000PACK\u0000\u0000\u0000\u0002`);
}

describe("a repository in the sandbox", () => {
	const repository = {
		owner: "acme",
		name: "site",
		externalId: "7",
		installationId: "99",
		defaultBranch: "main",
	};
	const BRANCH = "gateweave/conversation-1";

	it("is checked out before the first tool runs, and once", async () => {
		const sandbox = new MemorySandbox();
		const port = withCheckout(sandbox, repository, BRANCH);
		await port.writeFile("/workspace/repo/a.txt", "a");
		await port.run("git status", "/workspace/repo", 120);
		await port.readFile("/workspace/repo/a.txt");
		expect(sandbox.checkouts).toEqual([{ repository, branch: BRANCH }]);
		expect(sandbox.commands).toEqual([
			{ command: "git status", cwd: "/workspace/repo", timeoutSeconds: 120 },
		]);
	});

	it("answers a tool with why the checkout failed, and tries again on the next", async () => {
		const sandbox = new MemorySandbox();
		sandbox.checkoutAnswers.push({ error: "acme/site could not be checked out." });
		const port = withCheckout(sandbox, repository, BRANCH);
		expect(await port.run("ls", "/workspace", 120)).toEqual({
			exitCode: 1,
			output: "acme/site could not be checked out.",
			timedOut: false,
		});
		expect(sandbox.commands).toEqual([]);
		expect(await port.readFile("/workspace/repo/a.txt")).toEqual({
			error: "/workspace/repo/a.txt does not exist.",
		});
		expect(sandbox.checkouts).toHaveLength(2);
	});

	it("is described to the model with where it is and the branch it works on", () => {
		expect(repositoryNote(repository, BRANCH)).toBe(
			"Your sandbox has the repository acme/site at /workspace/repo, on the branch gateweave/conversation-1, made from main. Read its AGENTS.md or CLAUDE.md, if it has one, before you change it. Its files are checked out when you first use a tool. When the work is done and checked, open_pull_request proposes it as a pull request; git push does not work in the sandbox.",
		);
	});
});

describe("pull requests from the sandbox", () => {
	const repository = {
		owner: "acme",
		name: "site",
		externalId: "7",
		installationId: "99",
		defaultBranch: "main",
	};
	const BRANCH = "gateweave/conversation-1";
	const AUTHOR = { name: "Builder", email: "noreply@gateweave.com" };

	/** `open_pull_request` over a sandbox in memory and a GitHub that answers with `pulls`. */
	function setup(options: { ready?: () => Promise<string | null>; github?: PullRequestPort } = {}) {
		const sandbox = new MemorySandbox();
		const proposed: { branch: string; title: string; body: string }[] = [];
		const recorded: PullRequestOutcome[] = [];
		let open: number | null = null;
		const github: PullRequestPort = options.github ?? {
			async propose(input) {
				proposed.push(input);
				const opened = open === null;
				open ??= 12;
				return { number: open, url: `https://github.com/acme/site/pull/${open}`, opened };
			},
		};
		const run = { toolStarted: () => "span", toolEnded: () => {} } as unknown as RunRecorder;
		const tools = pullRequestTools({
			sandbox,
			ready: options.ready ?? (async () => null),
			github,
			repository,
			branch: BRANCH,
			author: async () => AUTHOR,
			record: async (outcome) => {
				recorded.push(outcome);
			},
			run,
		});
		const call = (input: object) => {
			const execute = tools.open_pull_request?.execute as
				| ((input: object, options: { toolCallId: string; messages: [] }) => Promise<unknown>)
				| undefined;
			if (!execute) throw new Error("No open_pull_request");
			return execute(input, { toolCallId: "call-1", messages: [] });
		};
		return { sandbox, proposed, recorded, call };
	}

	it("pushes the branch and opens a pull request, then pushes to the same one", async () => {
		const { sandbox, proposed, recorded, call } = setup();
		const first = await call({ title: "Fix the cart", body: "It ignored codes." });
		expect(first).toEqual({
			repository: "acme/site",
			number: 12,
			url: "https://github.com/acme/site/pull/12",
			opened: true,
			head: "1".repeat(40),
		});
		const second = await call({ title: "Fix the cart, and test it", body: "With a test." });
		expect(second).toMatchObject({ number: 12, opened: false, head: "2".repeat(40) });

		expect(sandbox.pushes).toEqual([
			{ branch: BRANCH, message: "Fix the cart", author: AUTHOR },
			{ branch: BRANCH, message: "Fix the cart, and test it", author: AUTHOR },
		]);
		expect(proposed).toEqual([
			{ branch: BRANCH, title: "Fix the cart", body: "It ignored codes." },
			{ branch: BRANCH, title: "Fix the cart, and test it", body: "With a test." },
		]);
		expect(recorded).toEqual([first, second]);
	});

	it("checks the repository out first, and opens nothing when that fails", async () => {
		const { sandbox, proposed, call } = setup({
			ready: async () => "acme/site could not be checked out.",
		});
		await expect(call({ title: "T", body: "" })).rejects.toThrow(
			"acme/site could not be checked out.",
		);
		expect(sandbox.pushes).toEqual([]);
		expect(proposed).toEqual([]);
	});

	it("opens nothing when there is nothing to push, or the push is refused", async () => {
		const { sandbox, proposed, recorded, call } = setup();
		sandbox.pushAnswers.push(
			{ error: "There is nothing to propose: the work has no commit that main does not." },
			{ error: "Someone else pushed to gateweave/conversation-1 since this conversation did." },
		);
		await expect(call({ title: "T", body: "" })).rejects.toThrow("There is nothing to propose");
		await expect(call({ title: "T", body: "" })).rejects.toThrow("Someone else pushed");
		expect(proposed).toEqual([]);
		expect(recorded).toEqual([]);
	});

	it("says the work is pushed when GitHub makes no pull request, and why", async () => {
		const refusing = (status: number): PullRequestPort => ({
			propose: async () => {
				throw new GitHubError(status, `GitHub answered ${status}: {}`);
			},
		});
		await expect(setup({ github: refusing(403) }).call({ title: "T", body: "" })).rejects.toThrow(
			"gateweave/conversation-1 is pushed, but the workspace's GitHub App may not open pull requests on acme/site. An owner or admin can give it the Pull requests permission.",
		);
		await expect(setup({ github: refusing(404) }).call({ title: "T", body: "" })).rejects.toThrow(
			"gateweave/conversation-1 is pushed, but the workspace's GitHub App no longer reaches acme/site.",
		);
	});
});
