import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	TRACK_TRIAGE_PROMPT,
	TRACK_TRIAGE_TOOLS,
	TRIGGER_LIMITS,
	type TrackTriagePlan,
} from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import type { RegistryDO } from "../src";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());
type Stub = ReturnType<typeof registry>;
const inside = <T>(stub: Stub, fn: (instance: RegistryDO) => T) =>
	runInDurableObject(stub, (instance: RegistryDO) => fn(instance));

const ADA = "user-ada";
const AGENT_KEY = `gwt_${"k".repeat(43)}`;
const PLAN: TrackTriagePlan = {
	trackUrl: "https://track.example.com/acme",
	agentKey: AGENT_KEY,
	provider: "anthropic",
	model: "claude-haiku-5-5",
	instructions: "Triage each new issue.\n",
};

async function setUp(stub: Stub, plan: Partial<TrackTriagePlan> = {}) {
	const made = await stub.setUpTrackTriage({ ...PLAN, ...plan }, ADA, "Ada");
	if ("status" in made) throw new Error(made.message);
	return made;
}

describe("Track triage", () => {
	it("makes the agent, its key, Track's MCP server and a trigger for new issues", async () => {
		const stub = registry();
		const { agent, trigger, mcpServerId } = await setUp(stub);
		expect(agent).toMatchObject({
			name: "Triage",
			runtime: "gateweave",
			description: "Triages each new issue in Gateweave Track (track.example.com).",
		});
		expect(trigger).toMatchObject({
			name: "New issues",
			prompt: TRACK_TRIAGE_PROMPT,
			target: { kind: "agent", agentId: agent.id },
			targetName: "Triage",
			active: true,
		});

		// The key is a secret of the agent's environment set, which only the runtime opens.
		const [environment] = await stub.listEnvSets();
		expect(environment).toMatchObject({
			asset: { name: "Track" },
			secrets: [{ name: "TRACK_AGENT_KEY", state: "set", setBy: "Ada" }],
		});
		expect(await stub.resolveEnvironment(agent.id)).toMatchObject({
			values: { TRACK_AGENT_KEY: AGENT_KEY },
		});
		const [server] = await stub.listMcpServers();
		expect(server?.asset).toMatchObject({ id: mcpServerId, name: "track" });
		const pages = JSON.stringify([await stub.listEnvSets(), await stub.listMcpServers()]);
		expect(pages).toContain("https://track.example.com/mcp");
		expect(pages).not.toContain(AGENT_KEY);

		// The agent may use triage's tools of Track's, and no others.
		expect((await stub.getAgent(agent.id))?.definition?.mcpServers).toEqual([
			expect.objectContaining({ tools: [...TRACK_TRIAGE_TOOLS] }),
		]);

		// A turn reaches Track's MCP server at its root, with the key in its header.
		await stub.saveProviderKey({ provider: "anthropic", key: "sk-ant-api03-abcdefgh" }, "Ada");
		const conversation = await stub.startConversation(agent.id, ADA);
		const turn = await stub.beginTurn(conversation?.id ?? "", "Triage TRK-1");
		if ("status" in turn) throw new Error(turn.message);
		expect(turn.agent).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
		expect(turn.mcpServers).toEqual([
			expect.objectContaining({
				name: "track",
				transport: "http",
				url: "https://track.example.com/mcp",
				headers: { Authorization: `Bearer ${AGENT_KEY}` },
				tools: [...TRACK_TRIAGE_TOOLS],
			}),
		]);
	});

	it("names what it makes anew when the library has those names already", async () => {
		const stub = registry();
		await setUp(stub);
		const second = await setUp(stub, {
			name: "Triage for Beta",
			trackUrl: "http://localhost:4710",
		});
		expect(second.agent.name).toBe("Triage for Beta");
		const servers = await stub.listMcpServers();
		expect(servers.map((server) => server.asset.name).sort()).toEqual(["track", "track 2"]);
		expect((await stub.listEnvSets()).map((set) => set.asset.name).sort()).toEqual([
			"Track",
			"Track 2",
		]);
		expect(await stub.listTriggers()).toHaveLength(2);
	});

	it("makes nothing when the workspace has as many triggers as it may", async () => {
		const stub = registry();
		const agentId = (
			await stub.createAgent({
				name: "Busy",
				description: null,
				provider: "anthropic",
				model: "claude-haiku-5-5",
				instructions: null,
			})
		).id;
		for (let i = 0; i < TRIGGER_LIMITS.perWorkspace; i++) {
			await stub.createTrigger(
				{ name: `Trigger ${i}`, prompt: "Go", target: { kind: "agent", agentId } },
				ADA,
			);
		}
		expect(await stub.setUpTrackTriage(PLAN, ADA, "Ada")).toEqual({
			status: "refused",
			message: `A workspace can have up to ${TRIGGER_LIMITS.perWorkspace} triggers`,
		});
		expect(await stub.listMcpServers()).toEqual([]);
		expect(await stub.listEnvSets()).toEqual([]);
	});

	it("refuses a key that is not a Track agent member's", async () => {
		const stub = registry();
		await expect(
			inside(stub, (instance) =>
				instance.setUpTrackTriage({ ...PLAN, agentKey: "sk-not-a-track-key" }, ADA, "Ada"),
			),
		).rejects.toThrow("Paste the whole key, starting with gwt_");
		expect(await stub.listMcpServers()).toEqual([]);
	});
});
