import type { SandboxBudgetPassed, TriggerTurnOutcome } from "@gateweave/agents-model";
import { RegistryDO as Registry } from "../src";

export { SandboxMeterDO } from "../src";

/** A scheduled run the registry began, as the tests read it back. */
export interface StartedTurn {
	conversationId: string;
	text: string;
}

const STARTED_KEY = "test:started-turns";
const BUDGET_KEY = "test:budget-passed";
const USAGE_KEY = "test:usage";
const DESTROYED_KEY = "test:destroyed";
const REFUSED_KEY = "test:refused";
const BATCHES_KEY = "test:batches";

/**
 * The registry, beginning scheduled runs as the app's does, but with no runtime: the run begins in
 * the registry alone (`beginTriggerTurn`), and the tests read what was begun, and what the app
 * would have emailed about the sandbox budget.
 */
export class RegistryDO extends Registry {
	protected override async startTriggerTurn(
		conversationId: string,
		text: string,
	): Promise<TriggerTurnOutcome> {
		const started = this.ctx.storage.kv.get<StartedTurn[]>(STARTED_KEY) ?? [];
		this.ctx.storage.kv.put(STARTED_KEY, [...started, { conversationId, text }]);
		const turn = await this.beginTriggerTurn(conversationId, text);
		return "status" in turn ? { runId: null, error: turn.message } : { runId: turn.runId };
	}

	protected override async destroyConversation(conversationId: string): Promise<void> {
		if (this.ctx.storage.kv.get<string[]>(REFUSED_KEY)?.includes(conversationId)) {
			throw new Error("That conversation cannot be reached");
		}
		const destroyed = this.ctx.storage.kv.get<string[]>(DESTROYED_KEY) ?? [];
		this.ctx.storage.kv.put(DESTROYED_KEY, [...destroyed, conversationId]);
	}

	override async alarm(): Promise<void> {
		const before = this.destroyedConversations().length;
		await super.alarm();
		const batches = this.ctx.storage.kv.get<number[]>(BATCHES_KEY) ?? [];
		this.ctx.storage.kv.put(BATCHES_KEY, [
			...batches,
			this.destroyedConversations().length - before,
		]);
	}

	/** How many conversations each alarm destroyed. */
	destroyedPerAlarm(): number[] {
		return this.ctx.storage.kv.get<number[]>(BATCHES_KEY) ?? [];
	}

	/** The conversations the app would have destroyed. */
	destroyedConversations(): string[] {
		return this.ctx.storage.kv.get<string[]>(DESTROYED_KEY) ?? [];
	}

	/** Has these fail to be destroyed, as an object that cannot be reached does. */
	refuseToDestroy(conversationIds: string[]): void {
		this.ctx.storage.kv.put(REFUSED_KEY, conversationIds);
	}

	startedTurns(): StartedTurn[] {
		return this.ctx.storage.kv.get<StartedTurn[]>(STARTED_KEY) ?? [];
	}

	protected override async sandboxBudgetPassed(passed: SandboxBudgetPassed): Promise<void> {
		const heard = this.ctx.storage.kv.get<SandboxBudgetPassed[]>(BUDGET_KEY) ?? [];
		this.ctx.storage.kv.put(BUDGET_KEY, [...heard, passed]);
	}

	protected override recordUsage(point: AnalyticsEngineDataPoint): void {
		const written = this.ctx.storage.kv.get<AnalyticsEngineDataPoint[]>(USAGE_KEY) ?? [];
		this.ctx.storage.kv.put(USAGE_KEY, [...written, point]);
		super.recordUsage(point);
	}

	/** The usage events this registry wrote, as the deployment's dataset would get them. */
	usageWritten(): AnalyticsEngineDataPoint[] {
		return this.ctx.storage.kv.get<AnalyticsEngineDataPoint[]>(USAGE_KEY) ?? [];
	}

	/** The shares of the sandbox budget this registry told of, as the app emails them. */
	budgetPassed(): SandboxBudgetPassed[] {
		return this.ctx.storage.kv.get<SandboxBudgetPassed[]>(BUDGET_KEY) ?? [];
	}
}

export default {
	fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
