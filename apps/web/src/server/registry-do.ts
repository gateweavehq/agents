import {
	KEYED_PROVIDERS,
	MODEL_PRICES,
	type ProviderKey,
	type ProviderModel,
	type ProviderRefusal,
	type SandboxBudgetPassed,
	type TriggerTurnOutcome,
} from "@gateweave/agents-model";
import { objectsIn, RegistryDO as Registry } from "@gateweave/agents-registry";
import { conversationName, destroyConversationObject } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { fillSandbox } from "./demo/fill";
import { assertDemo, demoEnabled, OFF_IN_DEMO } from "./demo/mode";
import { mailer } from "./email";
import { sandboxBudgetEmail } from "./email/templates";
import { runsPage } from "./runs-page";

/** What the public demo answers in place of something it has off. */
function offInDemo() {
	return { status: "refused" as const, message: OFF_IN_DEMO };
}

/**
 * The workspace's registry as this Worker runs it: the registry package's, which begins a
 * scheduled trigger's run in the runtime's conversation as the trigger gateway does for a webhook
 * (`./triggers.ts`), and emails whoever runs the server about its sandbox budget. The registry
 * package can reach neither on its own.
 *
 * On the public demo (`AGENTS_DEMO`), its turns answer with the scripted model and reach nothing
 * outside, and it refuses whatever would: keys, secrets, MCP servers, triggers, telemetry,
 * GitLab, scans, applying a setup and writing a wiki. Every provider seems to have a key, since
 * none is needed. A visitor's sandbox is filled here too.
 */
export class RegistryDO extends Registry {
	protected override standInTurns(): boolean {
		return demoEnabled();
	}

	protected override sampleAllowed(): boolean {
		return demoEnabled();
	}

	/**
	 * Fills a new demo sandbox with its sample workspace, for the demo's start alone. One call from
	 * the Worker, which may be an ocean away: the registry writes everything itself, then hands
	 * each past conversation to its object, which is beside it.
	 */
	async fillDemo(visitorId: string): Promise<void> {
		assertDemo();
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) throw new Error("This registry does not know its workspace");
		const conversations = objectsIn(this.env.CONVERSATIONS, this.ctx.id.jurisdiction);
		await fillSandbox(this, visitorId, Date.now(), (conversationId) =>
			getAgentByName(conversations, conversationName(workspaceId, conversationId)),
		);
	}

	/**
	 * On the demo, every provider seems to have a key, so any agent can be made and chatted with:
	 * the scripted model answers for all of them, and no key exists to open.
	 */
	override listProviderKeys(): ProviderKey[] {
		if (!demoEnabled()) return super.listProviderKeys();
		return KEYED_PROVIDERS.map((provider) => ({
			provider,
			hint: "demo",
			addedBy: "Gateweave",
			addedAt: 0,
			check: null,
		}));
	}

	/** On the demo, the models the app has prices for, without asking the provider. */
	override async listModels(provider: string): Promise<ProviderModel[] | ProviderRefusal> {
		if (!demoEnabled()) return super.listModels(provider);
		const prices = (MODEL_PRICES as Record<string, Record<string, unknown> | undefined>)[provider];
		return Object.keys(prices ?? {}).map((model) => ({ id: model, name: model }));
	}

	override removeProviderKey(provider: string): boolean {
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		return super.removeProviderKey(provider);
	}

	override async saveProviderKey(...args: Parameters<Registry["saveProviderKey"]>) {
		return demoEnabled() ? offInDemo() : super.saveProviderKey(...args);
	}

	override async checkProviderKey(...args: Parameters<Registry["checkProviderKey"]>) {
		return demoEnabled() ? offInDemo() : super.checkProviderKey(...args);
	}

	override async setEnvSecret(...args: Parameters<Registry["setEnvSecret"]>) {
		return demoEnabled() ? offInDemo() : super.setEnvSecret(...args);
	}

	override createMcpServer(...args: Parameters<Registry["createMcpServer"]>): string {
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		return super.createMcpServer(...args);
	}

	override editMcpServer(...args: Parameters<Registry["editMcpServer"]>): number {
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		return super.editMcpServer(...args);
	}

	override async mcpCheckTarget(...args: Parameters<Registry["mcpCheckTarget"]>) {
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		return super.mcpCheckTarget(...args);
	}

	override mcpOAuthBegin(...args: Parameters<Registry["mcpOAuthBegin"]>) {
		return demoEnabled() ? offInDemo() : super.mcpOAuthBegin(...args);
	}

	override async createTrigger(...args: Parameters<Registry["createTrigger"]>) {
		return demoEnabled() ? offInDemo() : super.createTrigger(...args);
	}

	override async setUpTrackTriage(...args: Parameters<Registry["setUpTrackTriage"]>) {
		return demoEnabled() ? offInDemo() : super.setUpTrackTriage(...args);
	}

	override async setUpTrackWork(...args: Parameters<Registry["setUpTrackWork"]>) {
		return demoEnabled() ? offInDemo() : super.setUpTrackWork(...args);
	}

	override async setTelemetry(...args: Parameters<Registry["setTelemetry"]>) {
		return demoEnabled() ? offInDemo() : super.setTelemetry(...args);
	}

	override async gitlabConnect(...args: Parameters<Registry["gitlabConnect"]>) {
		return demoEnabled() ? offInDemo() : super.gitlabConnect(...args);
	}

	/** The sample repositories have nothing behind them to read, so the demo never scans. */
	override async requestScans(...args: Parameters<Registry["requestScans"]>): Promise<number> {
		return demoEnabled() ? 0 : super.requestScans(...args);
	}

	override async applySetup(...args: Parameters<Registry["applySetup"]>) {
		if (!demoEnabled()) return super.applySetup(...args);
		return {
			status: "refused" as const,
			message:
				"Applying a setup opens a pull request, which the demo cannot do. Deploy your own Gateweave Agents to apply it.",
		};
	}

	override async startWiki(...args: Parameters<Registry["startWiki"]>) {
		return demoEnabled() ? offInDemo() : super.startWiki(...args);
	}

	protected override async sandboxBudgetPassed(passed: SandboxBudgetPassed): Promise<void> {
		await super.sandboxBudgetPassed(passed);
		const to = this.env.SANDBOX_ALERT_EMAIL?.trim();
		if (!to || !mailer) return;
		await mailer.send({
			to,
			...sandboxBudgetEmail({ ...passed, server: hostOf(this.env.BETTER_AUTH_URL) }),
		});
	}

	protected override async startTriggerTurn(
		conversationId: string,
		text: string,
	): Promise<TriggerTurnOutcome> {
		// Each registry is named for its workspace (`registryFor`).
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) return { runId: null, error: "This registry does not know its workspace" };
		// The workspace's conversations are where its registry is.
		const conversation = await getAgentByName(
			objectsIn(this.env.CONVERSATIONS, this.ctx.id.jurisdiction),
			conversationName(workspaceId, conversationId),
		);
		const workspace = await db
			.select({ slug: schema.organization.slug })
			.from(schema.organization)
			.where(eq(schema.organization.id, workspaceId))
			.get();
		return conversation.triggerTurn(text, workspace ? runsPage(workspace.slug) : null);
	}

	/**
	 * Destroys the conversation where the registry is and, if the workspace moved here, the sealed
	 * copy it left where it was.
	 */
	protected override async destroyConversation(conversationId: string): Promise<void> {
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) throw new Error("This registry does not know its workspace");
		const name = conversationName(workspaceId, conversationId);
		const places = [this.ctx.id.jurisdiction ?? ""];
		const from = this.movedFrom();
		if (from !== null && from !== places[0]) places.push(from);
		for (const place of places) {
			const conversation = await getAgentByName(objectsIn(this.env.CONVERSATIONS, place), name);
			await destroyConversationObject(conversation);
		}
	}
}

function hostOf(url: string | undefined): string {
	try {
		return url ? new URL(url).host : "this server";
	} catch {
		return "this server";
	}
}
