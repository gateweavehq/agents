import { describe, expect, it } from "vitest";
import { type PullRequestPort, pullRequestTools } from "../src/pull-requests";
import { sandboxTools } from "../src/sandbox-tools";
import { traced } from "../src/tools";
import type { RunRecorder } from "../src/trace";
import { MemorySandbox } from "./fake-sandbox";

/** A recorder that keeps the error each tool span ends with, which is what the run page shows. */
function recorderOf() {
	const errors: (string | null)[] = [];
	const run = {
		toolStarted: () => "span",
		toolEnded: (_span: string, outcome: { error: string | null }) => {
			errors.push(outcome.error);
		},
	} as unknown as RunRecorder;
	return { run, errors };
}

/** Calls the tool `name` with `input` and waits for it to throw; the call's result is ignored. */
async function failing(tools: Record<string, unknown>, name: string, input: object) {
	const execute = (tools[name] as { execute?: (...args: unknown[]) => Promise<unknown> })?.execute;
	if (!execute) throw new Error(`No tool ${name}`);
	await expect(execute(input, { toolCallId: "call-1", messages: [] })).rejects.toThrow();
}

describe("a failed tool call in the trace", () => {
	it("keeps the message a sandbox tool threw", async () => {
		const { run, errors } = recorderOf();
		const tools = sandboxTools(new MemorySandbox(), run);
		await failing(tools, "read_file", { path: "missing.txt" });
		expect(errors).toEqual(["The call failed: /workspace/missing.txt does not exist."]);
	});

	it("keeps the message open_pull_request threw", async () => {
		const { run, errors } = recorderOf();
		const github = {
			propose: async () => ({ number: 1, url: "", opened: true }),
		} as PullRequestPort;
		const tools = pullRequestTools({
			sandbox: new MemorySandbox(),
			ready: async () => "Nothing is checked out yet. Use a tool first.",
			github,
			repository: {
				owner: "acme",
				name: "site",
				externalId: "7",
				installationId: "99",
				defaultBranch: "main",
			},
			branch: "gateweave/conversation-1",
			author: { name: "Builder", email: "noreply@gateweave.com" },
			record: async () => {},
			run,
		});
		await failing(tools, "open_pull_request", { title: "Fix it", body: "" });
		expect(errors).toEqual(["The call failed: Nothing is checked out yet. Use a tool first."]);
	});

	it("clips a long message to 500 characters, the ellipsis included", async () => {
		const { run, errors } = recorderOf();
		const tools = sandboxTools(new MemorySandbox(), run);
		await failing(tools, "read_file", { path: "a".repeat(800) });
		const [error] = errors;
		expect(error).toHaveLength(500);
		expect(error?.startsWith("The call failed: /workspace/aaaa")).toBe(true);
		expect(error?.endsWith("…")).toBe(true);
	});

	it("keeps the message of a tool that opted in, and not that of one that did not", async () => {
		const { run, errors } = recorderOf();
		const thrower = {
			execute: async () => {
				throw new Error("Only the server knows what it answered: token abc123");
			},
		} as never;
		await failing({ search: traced(thrower, "acme", "search", run) }, "search", {});
		await failing(
			{ search: traced(thrower, "acme", "search", run, { showErrors: true }) },
			"search",
			{},
		);
		expect(errors).toEqual([
			"The call failed",
			"The call failed: Only the server knows what it answered: token abc123",
		]);
	});

	it("still says the turn was stopped when it was aborted", async () => {
		const { run, errors } = recorderOf();
		const aborted = {
			execute: async () => {
				throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
			},
		} as never;
		await failing(
			{ run_command: traced(aborted, "sandbox", "run_command", run, { showErrors: true }) },
			"run_command",
			{},
		);
		expect(errors).toEqual(["The turn was stopped"]);
	});
});
