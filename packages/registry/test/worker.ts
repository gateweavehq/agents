import type { TriggerTurnOutcome } from "@gateweave/agents-model";
import { RegistryDO as Registry } from "../src";

/** A scheduled run the registry began, as the tests read it back. */
export interface StartedTurn {
	conversationId: string;
	text: string;
}

const STARTED_KEY = "test:started-turns";

/**
 * The registry, beginning scheduled runs as the app's does, but with no runtime: the run begins in
 * the registry alone (`beginTriggerTurn`), and the tests read what was begun.
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

	startedTurns(): StartedTurn[] {
		return this.ctx.storage.kv.get<StartedTurn[]>(STARTED_KEY) ?? [];
	}
}

export default {
	fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
