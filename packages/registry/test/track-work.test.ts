import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	TRACK_WORK_PROMPT,
	TRACK_WORK_RUNS_PER_DAY,
	TRACK_WORK_TOOLS,
	type TrackWorkPlan,
} from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;
// A refusal thrown over RPC is also reported as unhandled, so those calls are made inside.
const inside = <T>(stub: Stub, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

const ADA = "user-ada";
const AGENT_KEY = `gwt_${"k".repeat(43)}`;

/** A repository the workspace's GitHub App reaches. */
async function withRepository(stub: Stub) {
	const [id = ""] = await stub.syncRepositories([
		{
			provider: "github",
			externalId: "7",
			installationId: "99",
			owner: "acme",
			name: "site",
			defaultBranch: "main",
			private: true,
		},
	]);
	return id;
}

function plan(repositoryId: string, rest: Partial<TrackWorkPlan> = {}): TrackWorkPlan {
	return {
		trackUrl: "https://track.example.com/acme",
		agentKey: AGENT_KEY,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		engine: "claude-code",
		repositoryId,
		instructions: "Work on the issues assigned to you.\n",
		memberId: "member-coder",
		...rest,
	};
}

describe("Track work", () => {
	it("makes an agent with a sandbox on the repository, and a trigger for its member's issues", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const made = await stub.setUpTrackWork(plan(repositoryId), ADA, "Ada");
		if ("status" in made) throw new Error(made.message);
		const { agent, trigger, mcpServerId } = made;
		expect(agent).toMatchObject({
			name: "Coder",
			runtime: "gateweave",
			description:
				"Works on the issues assigned to it in Gateweave Track (track.example.com), and opens a pull request of its work.",
		});
		expect((await stub.getAgent(agent.id))?.definition).toMatchObject({
			sandbox: true,
			engine: "claude-code",
			repository: { id: repositoryId },
			mcpServers: [expect.objectContaining({ tools: [...TRACK_WORK_TOOLS] })],
		});
		expect(trigger).toMatchObject({
			name: "Assigned issues",
			prompt: TRACK_WORK_PROMPT,
			target: { kind: "agent", agentId: agent.id },
			events: ["issue.created", "issue.updated"],
			label: null,
			assignee: "member-coder",
			perDay: TRACK_WORK_RUNS_PER_DAY,
			active: true,
		});

		// The key is the environment set's secret, as triage keeps it, and no page shows it.
		const [server] = await stub.listMcpServers();
		expect(server?.asset).toMatchObject({ id: mcpServerId, name: "track" });
		expect(await stub.resolveEnvironment(agent.id)).toMatchObject({
			values: { TRACK_AGENT_KEY: AGENT_KEY },
		});
		const pages = JSON.stringify([await stub.listEnvSets(), await stub.listMcpServers()]);
		expect(pages).toContain("https://track.example.com/mcp");
		expect(pages).not.toContain(AGENT_KEY);
		const [instructions] = (await stub.listLibrary()).filter(
			(entry) => entry.asset.kind === "instructions",
		);
		expect(instructions?.asset.name).toBe("Track issue work");
	});

	it("makes nothing when the engine does not fit the model, or the repository is not there", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		await expect(
			inside(stub, (instance) =>
				instance.setUpTrackWork(plan(repositoryId, { engine: "codex" }), ADA, "Ada"),
			),
		).rejects.toThrow("Codex calls OpenAI's models");
		await expect(
			inside(stub, (instance) => instance.setUpTrackWork(plan("no-such-repository"), ADA, "Ada")),
		).rejects.toThrow("There is no such repository in the workspace");
		expect(await stub.listMcpServers()).toEqual([]);
		expect(await stub.listEnvSets()).toEqual([]);
		expect(await stub.listTriggers()).toEqual([]);
	});
});
