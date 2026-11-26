import { RegistryDO as Registry } from "@gateweave/agents-registry";

export { ConversationAgent } from "../src";
export { FakeSandbox } from "./fake-sandbox";

export class RegistryDO extends Registry {
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
