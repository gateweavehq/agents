import { env } from "cloudflare:workers";
import type { TriggerTurnOutcome } from "@gateweave/agents-model";
import { RegistryDO as Registry } from "@gateweave/agents-registry";
import { getAgentByName } from "agents";
import { conversationName } from "../src";

export { ConversationAgent } from "../src";
export { FakeSandbox } from "./fake-sandbox";

export class RegistryDO extends Registry {
	/** Begins a review's run in its conversation, as the app's registry does. */
	protected override async startReviewTurn(
		conversationId: string,
		attemptId: string,
	): Promise<TriggerTurnOutcome> {
		const workspaceId = this.ctx.id.name ?? "";
		const conversation = await getAgentByName(
			env.CONVERSATIONS,
			conversationName(workspaceId, conversationId),
		);
		return conversation.reviewTurn(attemptId, "https://agents.example.test/runs/");
	}

	protected override recordUsage(point: AnalyticsEngineDataPoint): void {
		this.ctx.storage.kv.put("test:usage", [...this.usageWritten(), point]);
		super.recordUsage(point);
	}

	usageWritten(): AnalyticsEngineDataPoint[] {
		return this.ctx.storage.kv.get<AnalyticsEngineDataPoint[]>("test:usage") ?? [];
	}
}

export default {
	fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
