/**
 * Writes a repository's wiki (AGT-108), as a Workflow so that each model request is a step of its
 * own: one plans the pages, then one writes each page, then one makes the wiki the one people read.
 * A step that fails tries again on its own; a wiki that cannot be written is marked failed, and the
 * one people read stays as it was.
 *
 * The registry starts it (`startWiki`) and holds everything it makes. Each step asks the registry
 * for what it needs, the workspace's key among it, and hands back what it wrote. The key stays in
 * the step's memory: what a step returns is kept by Workflows, so no step returns the key, a
 * prompt or the repository's code, only how many pages there are or how long one was.
 */
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { KeyedProvider } from "@gateweave/agents-model";
import { WIKI_GONE, type WikiParams } from "@gateweave/agents-registry";
import {
	describeFailure,
	failureForLogs,
	type GatewaySettings,
	languageModel,
} from "@gateweave/agents-runtime";
import { APICallError } from "ai";
import { db } from "../auth";
import { findRegistry } from "../registry";
import { planWiki, WikiAnswerError, writeWikiPage } from "./write";

/** A model request takes a while; a retry waits for a provider that was limiting or down. */
const MODEL_STEP: WorkflowStepConfig = {
	retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
	timeout: "10 minutes",
};

/** The registry answers at once; a retry waits out a Durable Object's restart. */
const QUICK: WorkflowStepConfig = {
	retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
	timeout: "1 minute",
};

export class WikiWorkflow extends WorkflowEntrypoint<Env, WikiParams> {
	override async run(event: WorkflowEvent<WikiParams>, step: WorkflowStep): Promise<void> {
		const { workspaceId, generation } = event.payload;
		// Read again each time the workflow wakes, as the workspace may have moved since.
		const registry = await findRegistry(db, workspaceId);
		const settings = this.env as unknown as GatewaySettings;
		const modelOf = (chosen: { provider: KeyedProvider; model: string; key: string }) =>
			languageModel(chosen, chosen.key, settings, {
				workspace: workspaceId,
				agent: "wiki",
				conversation: generation,
			});
		try {
			const pages = await step.do("plan the pages", MODEL_STEP, async () => {
				const context = await registry.wikiPlanContext(generation);
				if ("status" in context) throw new NonRetryableError(context.message);
				if ("planned" in context) return context.planned;
				const { plan, tokens } = await asking(context.model, () =>
					planWiki(modelOf(context.model), context),
				);
				const saved = await registry.wikiSavePlan(generation, plan, { tokens });
				if (typeof saved !== "number") throw new NonRetryableError(saved.message);
				return saved;
			});
			for (let position = 0; position < pages; position++) {
				await step.do(`write page ${position + 1} of ${pages}`, MODEL_STEP, async () => {
					const context = await registry.wikiPageContext(generation, position);
					if ("status" in context) throw new NonRetryableError(context.message);
					const { page, tokens } = await asking(context.model, () =>
						writeWikiPage(modelOf(context.model), context),
					);
					if (!(await registry.wikiSavePage(generation, position, page, { tokens }))) {
						throw new NonRetryableError(WIKI_GONE);
					}
					return page.body.length;
				});
			}
			await step.do("make it the wiki people read", QUICK, async () => {
				if (!(await registry.wikiFinish(generation))) throw new NonRetryableError(WIKI_GONE);
			});
		} catch (error) {
			// A step's error comes back named after its class, "NonRetryableError: …", which is not
			// for people to read.
			const message =
				error instanceof Error && error.message
					? error.message.replace(/^(?:NonRetryable)?Error: /, "")
					: "It failed";
			await step.do("record why it failed", QUICK, async () => {
				await registry.wikiFail(generation, message);
			});
		}
	}
}

/**
 * Runs a model request, and makes its failure fit to keep and show: a provider's own message can
 * repeat part of the key, so it never passes. A refusal that asking again cannot change, such as
 * a key the provider does not take, fails the wiki at once instead of after every retry.
 */
async function asking<T>(
	chosen: { provider: KeyedProvider; model: string },
	request: () => Promise<T>,
): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (error instanceof WikiAnswerError) throw error;
		console.error("wiki: a model request failed", failureForLogs(error));
		const message = describeFailure(chosen, error);
		if (APICallError.isInstance(error) && !error.isRetryable) {
			throw new NonRetryableError(message);
		}
		throw new Error(message);
	}
}
