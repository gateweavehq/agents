import { DurableObject } from "cloudflare:workers";
import {
	SANDBOX_BUDGET_ALERTS,
	SANDBOX_SECOND_PRICE,
	type SandboxBudgetShare,
} from "@gateweave/agents-model";
import { z } from "zod";

/** The UTC month a moment falls in: its name, such as `2026-10`, and where it starts and ends. */
export interface UtcMonth {
	name: string;
	start: number;
	end: number;
}

export function utcMonth(now: number): UtcMonth {
	const date = new Date(now);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	return {
		name: `${year}-${String(month + 1).padStart(2, "0")}`,
		start: Date.UTC(year, month, 1),
		end: Date.UTC(year, month + 1, 1),
	};
}

/** The UTC day a moment falls in, from midnight to midnight. */
export function utcDay(now: number): { start: number; end: number } {
	const date = new Date(now);
	const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
	return { start, end: start + 24 * 60 * 60 * 1000 };
}

/** What the deployment has spent on sandboxes in a month, and the shares of its budget just passed. */
export interface MeterReading {
	/** US dollars, as `SANDBOX_SECOND_PRICE` prices sandbox time. */
	spent: number;
	/** Shares of the budget this reading passed first, so whoever runs the deployment hears once. */
	passed: SandboxBudgetShare[];
}

/** What a meter keeps: each month's figures by workspace, and the shares of the budget told of. */
export type MeterReadings = [string, Map<string, number> | SandboxBudgetShare[]][];

/** The name of the deployment's one meter. */
export const METER_NAME = "deployment";

const reading = z.object({
	month: z.string().regex(/^\d{4}-\d{2}$/),
	workspace: z.string().min(1).max(100),
	seconds: z.number().finite().min(0),
	budget: z.number().finite().min(0).nullable(),
});

/**
 * The deployment's sandbox spending, across its workspaces: one Durable Object for the whole
 * deployment, bound as `SANDBOX_METER` and named `METER_NAME`. Each workspace's registry tells it
 * how much sandbox time the workspace has used in the month before a turn with a sandbox begins and
 * after one ends, so the meter needs nothing but the latest figure of each. Only registries reach
 * it: it has no route.
 */
export class SandboxMeterDO extends DurableObject {
	/**
	 * Notes that `workspace` has used `seconds` of sandbox time in `month` so far, and reads what
	 * the deployment has spent that month, with the shares of `budget` it passed first.
	 */
	record(month: string, workspace: string, seconds: number, budget: number | null): MeterReading {
		const input = reading.parse({ month, workspace, seconds, budget });
		const { kv } = this.ctx.storage;
		const usage = kv.get<Map<string, number>>(`usage:${input.month}`) ?? new Map<string, number>();
		// Reports can arrive out of order, and a workspace's figure only grows within a month.
		usage.set(input.workspace, Math.max(usage.get(input.workspace) ?? 0, input.seconds));
		kv.put(`usage:${input.month}`, usage);
		let total = 0;
		for (const used of usage.values()) total += used;
		const spent = total * SANDBOX_SECOND_PRICE;
		const heard = kv.get<SandboxBudgetShare[]>(`alerts:${input.month}`) ?? [];
		const { budget: limit } = input;
		const passed =
			limit === null
				? []
				: SANDBOX_BUDGET_ALERTS.filter(
						(share) => !heard.includes(share) && spent >= limit * (share / 100),
					);
		if (passed.length > 0) kv.put(`alerts:${input.month}`, [...heard, ...passed]);
		return { spent, passed };
	}

	/**
	 * Everything the meter holds, for the app to take to the meter of a jurisdiction the deployment
	 * keeps its workspaces in ("Where a workspace lives" in docs/architecture.md).
	 */
	readings(): MeterReadings {
		return [...this.ctx.storage.kv.list<Map<string, number> | SandboxBudgetShare[]>()];
	}

	/**
	 * Adds another meter's readings to this one's: each workspace's figure is the larger of the two,
	 * as a figure only grows within a month, and a share either meter told of is told.
	 */
	takeReadings(readings: MeterReadings): void {
		const { kv } = this.ctx.storage;
		this.ctx.storage.transactionSync(() => {
			for (const [key, value] of readings) {
				if (key.startsWith("usage:") && value instanceof Map) {
					const usage = kv.get<Map<string, number>>(key) ?? new Map<string, number>();
					for (const [workspace, seconds] of value) {
						usage.set(workspace, Math.max(usage.get(workspace) ?? 0, seconds));
					}
					kv.put(key, usage);
				} else if (key.startsWith("alerts:") && Array.isArray(value)) {
					const heard = kv.get<SandboxBudgetShare[]>(key) ?? [];
					const told = value.filter((share) => !heard.includes(share));
					kv.put(key, [...heard, ...told]);
				}
			}
		});
	}

	/** Forgets everything, once another meter has taken the readings. */
	async clear(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
