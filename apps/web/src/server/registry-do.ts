import {
	KEYED_PROVIDERS,
	type MemoryAgentEvent,
	MODEL_PROVIDERS,
	type ModelProvider,
	type ProviderKey,
	type ProviderModel,
	type ProviderRefusal,
	pricedModels,
	type SandboxBudgetPassed,
	type SandboxMinutesPassed,
	type TriggerTurnOutcome,
} from "@gateweave/agents-model";
import { objectsIn, RegistryDO as Registry } from "@gateweave/agents-registry";
import { conversationName, destroyConversationObject } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { db } from "./auth";
import { schema } from "./db";
import { fillSandbox } from "./demo/fill";
import { assertDemo, demoEnabled, OFF_IN_DEMO } from "./demo/mode";
import { mailer } from "./email";
import { sandboxBudgetEmail, sandboxMinutesEmail } from "./email/templates";
import { runsPage } from "./runs-page";

/** What the public demo answers in place of something it has off. */
function offInDemo() {
	return { status: "refused" as const, message: OFF_IN_DEMO };
}

/**
 * The workspace's registry as this Worker runs it: the registry package's, which begins a
 * scheduled trigger's run in the runtime's conversation as the trigger gateway does for a webhook
 * (`./triggers.ts`), emails about sandbox limits, and writes what an agent remembered or forgot
 * to the audit log. The registry package can reach none of them on its own.
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
		if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) return [];
		return pricedModels(provider as ModelProvider).map((model) => ({ id: model, name: model }));
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

	override async trackConnectBegin(...args: Parameters<Registry["trackConnectBegin"]>) {
		return demoEnabled() ? offInDemo() : super.trackConnectBegin(...args);
	}

	override async saveTrackSource(...args: Parameters<Registry["saveTrackSource"]>) {
		return demoEnabled() ? ("refused" as const) : super.saveTrackSource(...args);
	}

	override removeTrackSource(...args: Parameters<Registry["removeTrackSource"]>) {
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		return super.removeTrackSource(...args);
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

	protected override async sandboxMinutesPassed(passed: SandboxMinutesPassed): Promise<void> {
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) return;
		await super.sandboxMinutesPassed(passed);
		const sender = mailer;
		if (!sender) return;
		const { member, organization, user } = schema;
		const owners = await db
			.selectDistinct({ email: user.email, workspace: organization.name })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.innerJoin(organization, eq(organization.id, member.organizationId))
			.where(
				and(
					eq(member.organizationId, workspaceId),
					sql`instr(',' || ${member.role} || ',', ',owner,') > 0`,
				),
			);
		const server = hostOf(this.env.BETTER_AUTH_URL);
		const deliveries = await Promise.allSettled(
			owners.map(({ email, workspace }) =>
				sender.send({ to: email, ...sandboxMinutesEmail({ ...passed, workspace, server }) }),
			),
		);
		if (deliveries.some(({ status }) => status === "rejected")) {
			throw new Error("A workspace's sandbox minutes alert could not be sent");
		}
	}

	/**
	 * An agent's write to the workspace's memory, in the audit log: by no member, naming the agent
	 * and its run, with the start of the text at most (`memoryExcerpt`).
	 */
	protected override async memoryChanged(event: MemoryAgentEvent): Promise<void> {
		// Each registry is named for its workspace (`registryFor`).
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) {
			// Ids only: a log must not hold a memory's words.
			console.error(
				`registry: this object does not know its workspace, so the memory ${event.memoryId} ${event.action} in the run ${event.runId} is not in the audit log`,
			);
			return;
		}
		await recordAudit(db, workspaceId, null, {
			action: event.action === "remembered" ? "memory.remembered" : "memory.forgotten",
			target: { type: "memory", id: event.memoryId, label: event.excerpt },
			detail: {
				agent: event.agentName,
				agentId: event.agentId,
				run: event.runId,
				...(event.action === "remembered"
					? { waiting: event.waiting, origin: event.origin, scope: event.scope }
					: {}),
			},
		});
	}

	protected override async startTriggerTurn(
		conversationId: string,
		text: string,
		attemptId: string,
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
		return conversation.triggerTurn(text, workspace ? runsPage(workspace.slug) : null, attemptId);
	}

	/** Begins a review's run in the conversation the alarm opened for it. */
	protected override async startReviewTurn(
		conversationId: string,
		attemptId: string,
	): Promise<TriggerTurnOutcome> {
		// Each registry is named for its workspace (`registryFor`).
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) return { runId: null, error: "This registry does not know its workspace" };
		// The workspace's conversations are where its registry is.
		const conversation = await getAgentByName(
			objectsIn(this.env.CONVERSATIONS, this.ctx.id.jurisdiction),
			conversationName(workspaceId, conversationId),
		);
		return conversation.reviewTurn(attemptId);
	}

	/**
	 * Destroys the conversation where the registry is and, if the workspace moved here, the sealed
	 * copy it left where it was.
	 */
	protected override async destroyConversation(conversationId: string): Promise<void> {
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) throw new Error("This registry does not know its workspace");
		const name = conversationName(workspaceId, conversationId);
		const here = this.ctx.id.jurisdiction ?? "";
		const conversation = await getAgentByName(objectsIn(this.env.CONVERSATIONS, here), name);
		await destroyConversationObject(conversation);

		const from = this.movedFrom();
		if (from === null || from === here) return;
		const location = await db
			.select()
			.from(schema.workspaceLocation)
			.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
			.get();
		if (location?.jurisdiction !== here || location.movedFrom !== from) return;
		// The sealed registry still lists this conversation for the daily run. Leave its seal
		// so that run can tell that the old copy has already been erased. A conversation started
		// after the move has nothing there to forget.
		const old = objectsIn(this.env.REGISTRY, from).getByName(workspaceId);
		if (!(await old.moveConversationsToForget()).includes(conversationId)) return;
		await objectsIn(this.env.CONVERSATIONS, from).getByName(name).moveForget();
		await old.moveNoteForgotten([conversationId]);
	}
}

function hostOf(url: string | undefined): string {
	try {
		return url ? new URL(url).host : "this server";
	} catch {
		return "this server";
	}
}
