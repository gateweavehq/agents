import type { McpCheckResult, McpServerEntry } from "@gateweave/agents-model";

export type McpOAuthHealthState = "connected" | "needs-reconnecting" | "could-not-check";

export interface McpOAuthHealth {
	assetId: string;
	name: string;
	agents: { id: string; name: string }[];
	state: McpOAuthHealthState;
	checkedAt: number;
	reason?: string;
}

export type HealthProbe = McpCheckResult & {
	kind?: "sign-in-again" | "temporary" | "http";
	statusCode?: number;
	checkedAt?: number;
};

const TIMEOUT_MS = 12_000;
const PARALLEL = 3;

/** A failed check has only the app's safe words, never a provider response or token. */
export function healthState(check: HealthProbe): McpOAuthHealthState {
	if (check.ok) return "connected";
	return check.kind === "sign-in-again" ? "needs-reconnecting" : "could-not-check";
}

/** Checks current OAuth connections only, with a per-server deadline and bounded parallelism. */
export async function checkOAuthHealth(
	servers: McpServerEntry[],
	check: (assetId: string, signal: AbortSignal) => Promise<HealthProbe>,
	options: {
		agentIds?: string[];
		timeoutMs?: number;
		hold?: (promise: Promise<unknown>) => void;
	} = {},
): Promise<McpOAuthHealth[]> {
	const selected = options.agentIds && new Set(options.agentIds);
	const connected = servers.filter(
		(server) =>
			server.oauth?.current && (!selected || server.agents.some((agent) => selected.has(agent.id))),
	);
	const results: McpOAuthHealth[] = new Array(connected.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(PARALLEL, connected.length) }, async () => {
			while (next < connected.length) {
				const index = next++;
				const server = connected[index];
				if (!server) continue;
				let state: McpOAuthHealthState = "could-not-check";
				let timer: ReturnType<typeof setTimeout> | undefined;
				const controller = new AbortController();
				let checkedAt = Date.now();
				let reason: string | undefined;
				try {
					const work = check(server.asset.id, controller.signal);
					options.hold?.(work);
					const result = await Promise.race([
						work,
						new Promise<HealthProbe>((resolve) => {
							timer = setTimeout(() => {
								controller.abort();
								resolve({ ok: false, error: "Timed out", kind: "temporary" });
							}, options.timeoutMs ?? TIMEOUT_MS);
						}),
					]);
					state = healthState(result);
					checkedAt = result.checkedAt ?? Date.now();
					if (!result.ok && state === "could-not-check") reason = result.error;
				} catch {
					state = "could-not-check";
				} finally {
					if (timer) clearTimeout(timer);
				}
				results[index] = {
					assetId: server.asset.id,
					name: server.asset.name,
					agents: server.agents.map(({ id, name }) => ({ id, name })),
					state,
					checkedAt,
					...(reason ? { reason } : {}),
				};
			}
		}),
	);
	return results;
}

/** Waits for a running check with bounded registry calls. */
export async function waitForHealthLease<T extends { kind: "busy" | "cached" | "claimed" }>(
	claim: () => Promise<T>,
	signal: AbortSignal,
): Promise<T | null> {
	let delay = 100;
	for (;;) {
		const result = await claim();
		if (result.kind !== "busy") return result;
		if (signal.aborted) return null;
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 2, 1000);
	}
}
