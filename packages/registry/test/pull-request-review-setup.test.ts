import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	REVIEW_SETUP_NAMES,
	REVIEW_SETUP_PROMPT,
	REVIEW_SETUP_RUNS_PER_DAY,
	type ReviewSetupPlan,
} from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;
const inside = <T>(stub: Stub, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));
const ADA = "user-ada";

async function withRepository(stub: Stub, provider: "github" | "gitlab" = "github") {
	const [id = ""] = await stub.syncRepositories([
		{
			provider,
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

function plan(repositoryId: string, rest: Partial<ReviewSetupPlan> = {}): ReviewSetupPlan {
	return {
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		engine: "gateweave",
		repositoryId,
		instructions: "Review as a second reader, never the approval.\n",
		...rest,
	};
}

describe("the ready-made pull request reviewer", () => {
	it("makes the instructions, a memoryless sandbox agent and its pull request trigger in one write", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const made = await stub.setUpPullRequestReview(plan(repositoryId), ADA);
		if ("status" in made) throw new Error(made.message);
		expect(made.agent).toMatchObject({ name: REVIEW_SETUP_NAMES.agent, runtime: "gateweave" });
		expect((await stub.getAgent(made.agent.id))?.definition).toMatchObject({
			sandbox: true,
			engine: "gateweave",
			memory: false,
			repository: { id: repositoryId },
			mcpServers: [],
		});
		expect(made.trigger).toMatchObject({
			name: REVIEW_SETUP_NAMES.trigger,
			prompt: REVIEW_SETUP_PROMPT,
			target: { kind: "agent", agentId: made.agent.id },
			perDay: REVIEW_SETUP_RUNS_PER_DAY,
			pullRequest: true,
			events: null,
			schedule: null,
		});
		const [instructions] = (await stub.listLibrary()).filter(
			(entry) => entry.asset.kind === "instructions",
		);
		expect(instructions?.asset).toMatchObject({
			id: made.instructionsId,
			name: REVIEW_SETUP_NAMES.instructions,
		});
	});

	it("makes nothing when the engine does not fit the provider or the repository cannot be used", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		await expect(
			inside(stub, (instance) =>
				instance.setUpPullRequestReview(
					plan(repositoryId, { engine: "codex", provider: "anthropic" }),
					ADA,
				),
			),
		).rejects.toThrow("Codex calls OpenAI's models");
		const gitlab = await withRepository(stub, "gitlab");
		await expect(
			inside(stub, (instance) => instance.setUpPullRequestReview(plan(gitlab), ADA)),
		).rejects.toThrow();
		expect(await stub.listLibrary()).toEqual([]);
		expect(await stub.listAgents()).toEqual([]);
		expect(await stub.listTriggers()).toEqual([]);
	});

	it("refuses memory for an agent with a pull request trigger, at setup and later", async () => {
		const stub = registry();
		const repositoryId = await withRepository(stub);
		const memoryful = await stub.createAgent({
			name: "Memoryful reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			sandbox: true,
			memory: true,
		});
		expect(
			await stub.createReviewTrigger(
				{
					name: "Review memoryful",
					prompt: "Review it",
					target: { kind: "agent", agentId: memoryful.id },
				},
				ADA,
			),
		).toMatchObject({ status: "refused", message: expect.stringContaining("memory on") });

		const made = await stub.setUpPullRequestReview(plan(repositoryId), ADA);
		if ("status" in made) throw new Error(made.message);
		const agent = await stub.getAgent(made.agent.id);
		const definition = agent?.definition;
		if (!agent || !definition) throw new Error("The reviewer is missing");
		const update = {
			name: agent.agent.name,
			description: agent.agent.description,
			provider: definition.provider,
			model: definition.model,
			instructions: definition.instructions
				? { assetId: definition.instructions.asset.id, version: definition.instructions.version }
				: null,
			environment: null,
			mcpServers: [],
			sandbox: true,
			repositoryId,
			engine: "gateweave" as const,
			memory: true,
			files: false,
			outsideTasks: false,
			allowedTargets: [],
			anyTarget: false,
		};
		await expect(
			inside(stub, (instance) =>
				instance.updateAgent(made.agent.id, update, agent.agent.updatedAt),
			),
		).rejects.toThrow("cannot use memory");
		expect((await stub.getAgent(made.agent.id))?.definition?.memory).toBe(false);
	});
});
