import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName } from "../src";
import type { FakeSandbox } from "./fake-sandbox";
import { anthropicStream, anthropicToolCall, ask, connect, fakeModel, KEY } from "./support";

const SECRET_TEXT = "what the file says, which the trace must not";

afterEach(() => {
	vi.restoreAllMocks();
});

const SITE = {
	provider: "github" as const,
	externalId: "7",
	installationId: "99",
	owner: "acme",
	name: "site",
	defaultBranch: "main",
	private: true,
};

/** A conversation with an agent that has a sandbox, or not, and a repository in it, or not. */
async function conversation({
	sandbox,
	repository = false,
}: {
	sandbox: boolean;
	repository?: boolean;
}) {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const [repositoryId = null] = repository ? await registry.syncRepositories([SITE]) : [];
	const agent = await registry.createAgent({
		name: "Builder",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: await rules(registry), version: 1 },
		sandbox,
		repositoryId,
	});
	const conversationId = (await registry.startConversation(agent.id, "user-ada"))?.id ?? "";
	const name = conversationName(workspaceId, conversationId);
	const stub = await getAgentByName(env.CONVERSATIONS, name);
	const machine = (env.SANDBOX as unknown as DurableObjectNamespace<FakeSandbox>).getByName(name);
	return { registry, stub, machine, conversationId };
}

/** Instructions of the agent's, which the model reads before anything about a repository. */
function rules(registry: ReturnType<typeof env.REGISTRY.getByName>) {
	return registry.createLibraryAsset({ kind: "instructions", name: "rules", text: "Be brief.\n" });
}

describe("a conversation with a sandbox", () => {
	it("gives the agent tools that work on its own machine, traced without their content", async () => {
		const requests = fakeModel((call) => {
			if (call === 0)
				return anthropicToolCall("write_file", { path: "a.txt", content: SECRET_TEXT });
			if (call === 1) return anthropicToolCall("run_command", { command: "wc -c a.txt" });
			return anthropicStream("The file is written.");
		});
		const { registry, stub, machine } = await conversation({ sandbox: true });
		const socket = await connect(stub);
		const turn = await ask(socket, "Write a.txt, then count it");
		socket.close();

		expect(turn).toMatchObject({ text: "The file is written.", error: null });
		const tools = (requests[0]?.body.tools ?? []) as { name: string }[];
		const names = tools.map((tool) => tool.name);
		expect(names.sort()).toEqual([
			"edit_file",
			"find_files",
			"read_file",
			"run_command",
			"search",
			"write_file",
		]);
		// The sandbox is the conversation's own, under its name.
		expect(await machine.seen()).toMatchObject({
			files: { "/workspace/a.txt": SECRET_TEXT },
			commands: [{ command: "wc -c a.txt", cwd: "/workspace", timeoutSeconds: 120 }],
		});
		expect(JSON.stringify(requests[1]?.body.messages)).toContain(
			`Wrote ${SECRET_TEXT.length} bytes to /workspace/a.txt.`,
		);
		expect(JSON.stringify(requests[2]?.body.messages)).toContain("ran: wc -c a.txt");

		const [run] = await registry.listRuns();
		expect(run).toMatchObject({ status: "succeeded", steps: 3 });
		const trace = await stub.runTrace(run?.id ?? "");
		expect(trace.filter((span) => span.kind === "tool")).toMatchObject([
			{ step: 0, status: "ok", server: "sandbox", tool: "write_file", error: null },
			{ step: 1, status: "ok", server: "sandbox", tool: "run_command", error: null },
		]);
		expect(JSON.stringify(trace)).not.toContain(SECRET_TEXT);
	});

	it("checks out the agent's repository on a branch of the conversation's own, and says so", async () => {
		const requests = fakeModel((call) =>
			call === 0
				? anthropicToolCall("run_command", { command: "git log -1", cwd: "repo" })
				: anthropicStream("It builds."),
		);
		const { stub, machine, conversationId } = await conversation({
			sandbox: true,
			repository: true,
		});
		const socket = await connect(stub);
		const turn = await ask(socket, "Does it build?");
		socket.close();

		expect(turn).toMatchObject({ text: "It builds.", error: null });
		const branch = `gateweave/${conversationId}`;
		expect(await machine.seen()).toMatchObject({
			checkouts: [
				{
					repository: {
						owner: "acme",
						name: "site",
						externalId: "7",
						installationId: "99",
						defaultBranch: "main",
					},
					branch,
				},
			],
			commands: [{ command: "git log -1", cwd: "/workspace/repo" }],
		});
		// The agent's instructions come first, then where the repository is.
		const system = JSON.stringify(requests[0]?.body.system);
		expect(system).toContain("Be brief.");
		expect(system).toContain(`acme/site at /workspace/repo, on the branch ${branch}`);
		expect(system.indexOf("Be brief.")).toBeLessThan(system.indexOf("acme/site"));
	});

	it("goes when the conversation is deleted", async () => {
		const { stub, machine } = await conversation({ sandbox: true });
		await stub.destroy();
		expect(await machine.seen()).toMatchObject({ destroyed: true });
	});
});

describe("a conversation without a sandbox", () => {
	it("gives the agent no sandbox tools, and never reaches one", async () => {
		const requests = fakeModel(() => anthropicStream("Done."));
		const { stub, machine } = await conversation({ sandbox: false });
		const socket = await connect(stub);
		await ask(socket, "Run the tests");
		socket.close();

		expect(requests[0]?.body.tools).toBeUndefined();
		expect(JSON.stringify(requests[0]?.body.system)).not.toContain("/workspace");
		expect(await machine.seen()).toEqual({
			files: {},
			commands: [],
			checkouts: [],
			destroyed: false,
		});
	});
});
