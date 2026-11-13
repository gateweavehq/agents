import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

describe("sample data", () => {
	// Only the app's public demo fills a registry with made-up history (`sampleAllowed`). Anywhere
	// else, history is what really ran.
	it("is refused by a registry that is not the demo's", async () => {
		const stub = env.REGISTRY.getByName(crypto.randomUUID());
		const agent = await stub.createAgent({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
		});
		const now = Date.now();

		await runInDurableObject(stub, (registry: RegistryDO) => {
			expect(() =>
				registry.importSample({
					startedBy: "someone",
					conversations: [
						{
							id: crypto.randomUUID(),
							agentId: agent.id,
							teamId: null,
							rootId: null,
							title: "Made up",
							startedAt: now,
							updatedAt: now,
						},
					],
					runs: [],
					applications: [],
					wikis: [],
				}),
			).toThrow("This server does not take sample data");
		});
		expect(await stub.listConversations("someone")).toEqual([]);
	});
});
