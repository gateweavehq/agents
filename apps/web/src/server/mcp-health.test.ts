import type { McpServerEntry } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import { checkOAuthHealth, waitForHealthLease } from "./mcp-health";

const secret = "access-token-must-not-leave";
const signInAgain =
	"Its OAuth connection no longer works. An owner or admin can connect it again on the MCP page";

function server(assetId: string, agentId: string): McpServerEntry {
	return {
		asset: { id: assetId, name: assetId } as McpServerEntry["asset"],
		connection: { transport: "http", url: `https://${assetId}.example/mcp` },
		variables: [],
		agents: [{ id: agentId, name: agentId, version: 1 }],
		check: null,
		oauth: { connectedBy: "user", connectedAt: 1, current: true },
	};
}

describe("MCP OAuth health", () => {
	it("keeps a healthy or refreshable connection connected, without returning a token", async () => {
		const results = await checkOAuthHealth([server("one", "agent")], async () => ({
			ok: true,
			tools: [{ name: "search", description: secret }],
		}));
		expect(results).toEqual([
			expect.objectContaining({
				assetId: "one",
				name: "one",
				agents: [{ id: "agent", name: "agent" }],
				state: "connected",
				checkedAt: expect.any(Number),
			}),
		]);
		expect(JSON.stringify(results)).not.toContain(secret);
	});

	it("asks for reconnecting only when OAuth says sign in again", async () => {
		for (const error of [signInAgain]) {
			const [result] = await checkOAuthHealth([server("one", "agent")], async () => ({
				ok: false,
				error,
				kind: "sign-in-again",
			}));
			expect(result?.state).toBe("needs-reconnecting");
		}
		for (const statusCode of [401, 403]) {
			const [result] = await checkOAuthHealth([server("one", "agent")], async () => ({
				ok: false,
				error: `HTTP ${statusCode}`,
				kind: "http",
				statusCode,
			}));
			expect(result?.state).toBe("could-not-check");
		}
	});

	it("calls a timeout or temporary network failure could not check", async () => {
		let aborted = false;
		const [timeout] = await checkOAuthHealth(
			[server("one", "agent")],
			(_id, signal) =>
				new Promise(() => {
					signal.addEventListener("abort", () => {
						aborted = true;
					});
				}),
			{ timeoutMs: 5 },
		);
		expect(timeout?.state).toBe("could-not-check");
		expect(aborted).toBe(true);
		const [network] = await checkOAuthHealth([server("one", "agent")], async () => ({
			ok: false,
			error: "It could not be reached",
		}));
		expect(network?.state).toBe("could-not-check");
	});

	it("selects only pinned agents in the requested workspace", async () => {
		const seen: string[] = [];
		const servers = [server("one", "agent-a"), server("two", "agent-b")];
		const result = await checkOAuthHealth(
			servers,
			async (id) => {
				seen.push(id);
				return { ok: true, tools: [] };
			},
			{ agentIds: ["agent-b"] },
		);
		expect(seen).toEqual(["two"]);
		expect(result.map((entry) => entry.assetId)).toEqual(["two"]);
	});

	it("runs at most three checks at once", async () => {
		let active = 0;
		let peak = 0;
		await checkOAuthHealth(
			Array.from({ length: 8 }, (_, index) => server(`server-${index}`, `agent-${index}`)),
			async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active--;
				return { ok: true, tools: [] };
			},
		);
		expect(peak).toBe(3);
	});
});

describe("health lease wait", () => {
	it("backs off instead of polling the registry every 50 ms", async () => {
		let calls = 0;
		const started = Date.now();
		const result = await waitForHealthLease(async () => {
			calls++;
			return calls < 3 ? { kind: "busy" as const } : { kind: "claimed" as const };
		}, new AbortController().signal);
		expect(result?.kind).toBe("claimed");
		expect(calls).toBe(3);
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);
	});
});
