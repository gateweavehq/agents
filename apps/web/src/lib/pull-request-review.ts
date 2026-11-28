/**
 * The ready-made reviewer of pull requests this workspace's agents open, for owners and admins:
 * the registry makes its instructions, the memoryless sandbox agent and its `pull_request`
 * trigger in one write. Reviews spend the workspace's provider key and sandbox minutes, as every
 * other run of its agents does.
 */
import {
	isKeyedProvider,
	providerMissing,
	reviewSetupInput,
	sandboxOfferTo,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export interface PullRequestReviewSetUp {
	agentId: string;
	agentName: string;
	triggerId: string;
}

export const setUpPullRequestReview = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), review: reviewSetupInput }))
	.handler(async ({ data }): Promise<PullRequestReviewSetUp> => {
		const { demoEnabled, OFF_IN_DEMO } = await import("#/server/demo/mode");
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		const [{ currentMember }, { isAdmin }, { registryFor }, { env }] = await Promise.all([
			import("#/server/access"),
			import("#/lib/roles"),
			import("#/server/registry"),
			import("cloudflare:workers"),
		]);
		const member = await currentMember(data.slug);
		if (!member) throw new Error("Workspace not found");
		if (!isAdmin(member.membership.role)) throw new Error("Only admins can do this");
		const { workspaceId } = member.membership;
		const registry = registryFor(member.membership);
		const { provider } = data.review;
		if (isKeyedProvider(provider)) {
			const keys = await registry.listProviderKeys();
			if (!keys.some((key) => key.provider === provider)) {
				throw new Error(`${providerMissing(provider)}. Add one in Settings first.`);
			}
		} else {
			const { workersAiOffer } = await import("#/server/workers-ai");
			if (workersAiOffer(workspaceId) !== "offered")
				throw new Error(`${providerMissing(provider)}.`);
		}
		if (sandboxOfferTo(env, workspaceId) !== "offered") {
			throw new Error("This server does not run sandboxes for this workspace.");
		}
		const { default: instructions } = await import(
			"#/server/pull-request-review-instructions.md?raw"
		);
		const made = await registry.setUpPullRequestReview(
			{ ...data.review, instructions },
			member.user.id,
		);
		if ("status" in made) throw new Error(made.message);
		const { auditFor } = await import("#/server/audit");
		await auditFor(member)({
			action: "pullRequestReview.setUp",
			target: { type: "agent", id: made.agent.id, label: made.agent.name },
			detail: { trigger: made.trigger.id },
		});
		return { agentId: made.agent.id, agentName: made.agent.name, triggerId: made.trigger.id };
	});
