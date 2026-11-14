import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import { expect, it } from "vitest";
import {
	describeEdgeCall,
	describePullRequestCall,
	describeToolCall,
	describeToolTarget,
	toolCallsOf,
} from "./tool-calls";

const call = { type: "dynamic-tool", toolCallId: "call-1", input: { query: "flaky" } } as const;

it("names the server and the tool, and says how the call went", () => {
	const parts: DynamicToolUIPart[] = [
		{ ...call, toolName: "acme__search", state: "input-available" },
		{ ...call, toolName: "acme__search", state: "output-available", output: { content: [] } },
		{
			...call,
			toolName: "acme__search",
			state: "output-available",
			output: { content: [], isError: true },
		},
		{ ...call, toolName: "acme__search", state: "output-error", errorText: "Failed" },
		{ ...call, toolName: "search", state: "output-available", output: "plain" },
	];
	expect(parts.map(describeToolCall)).toEqual([
		{ server: "acme", tool: "search", state: "running" },
		{ server: "acme", tool: "search", state: "done" },
		{ server: "acme", tool: "search", state: "failed" },
		{ server: "acme", tool: "search", state: "failed" },
		{ server: null, tool: "search", state: "done" },
	]);
});

it("finds the calls in a message the conversation stored, as well as in one streaming in", () => {
	// The conversation stores every call as a static part named after its tool, MCP tools too.
	const stored = {
		type: "tool-acme__search",
		toolCallId: "call-1",
		toolName: "acme__search",
		state: "output-available",
		input: { query: "flaky" },
		output: { content: [] },
	} as ToolUIPart;
	const live = { ...call, toolName: "acme__search", state: "input-available" } as DynamicToolUIPart;
	const message = (parts: UIMessage["parts"]): UIMessage => ({ id: "m", role: "assistant", parts });

	expect(
		toolCallsOf(message([{ type: "step-start" }, stored, { type: "text", text: "Found it." }])),
	).toEqual([stored]);
	expect(toolCallsOf(message([live]))).toEqual([live]);
	expect(describeToolCall(stored)).toEqual({ server: "acme", tool: "search", state: "done" });
});

it("shows a call over a team's edge as its kind and the member it went to", () => {
	const members = ["Planner", "Code reviewer", "QA"];
	const edge = (type: string, state: object) =>
		({ type, toolCallId: "call-2", input: { task: "Review it" }, ...state }) as ToolUIPart;
	expect(
		describeEdgeCall(edge("tool-delegate__Code_reviewer", { state: "input-available" }), members),
	).toEqual({ edge: "delegate", member: "Code reviewer", state: "running", error: null });
	expect(
		describeEdgeCall(
			edge("tool-ask__QA", { state: "output-available", output: "It passes." }),
			members,
		),
	).toEqual({ edge: "ask", member: "QA", state: "done", error: null });
	expect(
		describeEdgeCall(
			edge("tool-report__QA", {
				state: "output-error",
				errorText: "That edge is no longer in the team",
			}),
			members,
		),
	).toEqual({
		edge: "report",
		member: "QA",
		state: "failed",
		error: "That edge is no longer in the team",
	});
	expect(describeEdgeCall(edge("tool-acme__search", { state: "input-available" }), members)).toBe(
		null,
	);
});

it("shows a call of open_pull_request by the pull request it made, linking only to GitHub", () => {
	const pull = (state: object, type = "tool-open_pull_request") =>
		({
			type,
			toolCallId: "call-3",
			input: { title: "Fix the cart", body: "" },
			...state,
		}) as ToolUIPart;
	const made = {
		repository: "acme/site",
		number: 12,
		url: "https://github.com/acme/site/pull/12",
		opened: true,
		head: "a".repeat(40),
	};
	expect(describePullRequestCall(pull({ state: "input-available" }))).toEqual({
		state: "running",
		pullRequest: null,
		error: null,
	});
	expect(describePullRequestCall(pull({ state: "output-available", output: made }))).toEqual({
		state: "done",
		pullRequest: { number: 12, url: "https://github.com/acme/site/pull/12", opened: true },
		error: null,
	});
	expect(
		describePullRequestCall(
			pull({ state: "output-available", output: { ...made, url: "https://evil.example/pull/12" } }),
		),
	).toEqual({ state: "done", pullRequest: null, error: null });
	expect(
		describePullRequestCall(
			pull({ state: "output-error", errorText: "There is nothing to propose" }),
		),
	).toEqual({ state: "failed", pullRequest: null, error: "There is nothing to propose" });
	expect(
		describePullRequestCall({ ...call, toolName: "search", state: "output-available", output: "" }),
	).toBeNull();
});

const used = (toolName: string, input: unknown) =>
	({
		type: `tool-${toolName}`,
		toolCallId: "c",
		toolName,
		state: "output-available",
		input,
		output: {},
	}) as ToolUIPart;

it("says what a call acted on, by the arguments that name it", () => {
	expect(describeToolTarget(used("read_file", { path: "docs/roadmap.md" }))).toEqual({
		label: "docs/roadmap.md",
		full: "docs/roadmap.md",
	});
	expect(
		describeToolTarget(
			used("edit_file", { path: "docs/roadmap.md", old_text: "a", new_text: "b" }),
		),
	).toMatchObject({ label: "docs/roadmap.md" });
	expect(describeToolTarget(used("run_command", { command: "pnpm  check\n" }))?.label).toBe(
		"pnpm check",
	);
	expect(
		describeToolTarget(used("track__get_issue", { workspace: "w", key: "TRK-137" }))?.label,
	).toBe("TRK-137");
	expect(describeToolTarget(used("track__search_issues", { query: "flaky login" }))?.label).toBe(
		"flaky login",
	);
	expect(describeToolTarget(used("find_files", { pattern: "**/*.md" }))?.label).toBe("**/*.md");
});

it("shows nothing for a call with no known argument, or none at all", () => {
	expect(describeToolTarget(used("get_workspace", { workspace: "gateweave" }))).toBeNull();
	expect(describeToolTarget(used("x", null))).toBeNull();
	expect(describeToolTarget(used("x", "str"))).toBeNull();
	// `key` names an issue only when its value looks like an issue's key.
	expect(describeToolTarget(used("x", { key: "plain-text-value" }))).toBeNull();
});

it("clips a long target and keeps the whole of it for the title", () => {
	const path = `docs/${"a".repeat(100)}.md`;
	const target = describeToolTarget(used("read_file", { path }));
	expect(target?.label).toHaveLength(60);
	expect(target?.label.endsWith("…")).toBe(true);
	expect(target?.full).toBe(path);
});

it("shows what a command is, never what it was given", () => {
	const shown = (command: string) => describeToolTarget(used("run_command", { command }));
	expect(shown("pnpm check")).toEqual({ label: "pnpm check", full: "pnpm check" });
	expect(shown("git status --short")?.full).toBe("git status");
	expect(shown("pnpm --filter @gateweave/agents-web test")?.full).toBe("pnpm");
	// Only a build tool's or git's own word follows the program; a path or any other word doesn't.
	expect(shown("cat docs/roadmap.md")?.full).toBe("cat");
	expect(shown("pnpm hunter2")?.full).toBe("pnpm");
	// A password can sit anywhere, as a flag's value, in an address, or as a plain word.
	for (const command of [
		"curl -u alice:hunter2 https://example.com",
		"mysql -u root -phunter2 shop",
		"psql postgres://alice:hunter2@db.example.com/shop",
		'git commit -m "hunter2"',
		"docker login registry.example.com --password hunter2",
		"echo hunter2 | docker login --username alice --password-stdin registry.example.com",
		"printf hunter2",
	]) {
		expect(JSON.stringify(shown(command)), command).not.toContain("hunter2");
	}
	expect(shown("PASSWORD=hunter2 ./deploy.sh")).toBeNull();
	expect(shown("./deploy.sh hunter2")).toBeNull();
	// A program named like something every object has is still only a name.
	for (const program of ["constructor", "toString", "hasOwnProperty"]) {
		expect(shown(`${program} status`)?.full).toBe(program);
	}
	// And one that does not start like a program's name is not shown at all.
	expect(shown("__proto__ status")).toBeNull();
});

it("never shows an argument that looks like a secret", () => {
	// By name: nothing from `token`, `apiKey` or `password`, and never a whole input.
	const input = { token: "abc123", apiKey: "k", password: "p", authorization: "Bearer z" };
	expect(describeToolTarget(used("x", input))).toBeNull();
	expect(JSON.stringify(describeToolTarget(used("x", { ...input, path: "a.txt" })))).not.toMatch(
		/abc123|Bearer/,
	);
	// By value: a command with a credential shows its program only.
	const curl = describeToolTarget(
		used("run_command", {
			command: "curl -H 'Authorization: Bearer sk-live-0123456789' https://x",
		}),
	);
	expect(curl).toEqual({ label: "curl", full: "curl" });
	// A session cookie is a credential too.
	expect(
		describeToolTarget(
			used("run_command", { command: "curl -H 'Cookie: session=abc123' https://example.com" }),
		),
	).toEqual({ label: "curl", full: "curl" });
	expect(
		describeToolTarget(
			used("run_command", { command: "GITHUB_TOKEN=ghp_abcdefghij1234 gh pr list" }),
		),
	).toBeNull();
	expect(describeToolTarget(used("search", { pattern: "api_key=abcdef" }))).toBeNull();
});
