import { describe, expect, it } from "vitest";
import { SANDBOX_LIFETIME_MS } from "./demo-lifetime";
import { OPENING_STEPS, STEP_TIMERS_MS, stepStates, WORKSPACE_WAIT_CAP_MS } from "./demo-opening";
import { deletionLabel } from "./demo-time";

const LAST = OPENING_STEPS.length - 1;
const SERVER_LAST = LAST - 1;

describe("the opening screen's steps", () => {
	it("starts with the first step active", () => {
		const states = stepStates({ elapsedMs: 0, sinceServerMs: null, workspaceShown: false });
		expect(states[0]).toBe("active");
		expect(states.slice(1).every((state) => state === "idle")).toBe(true);
	});

	it("moves the first steps on their timers, one at a time", () => {
		STEP_TIMERS_MS.forEach((at, index) => {
			const states = stepStates({ elapsedMs: at, sinceServerMs: null, workspaceShown: false });
			expect(states.slice(0, index + 1).every((state) => state === "done")).toBe(true);
			expect(states[index + 1]).toBe("active");
			expect(states.slice(index + 2).every((state) => state === "idle")).toBe(true);
		});
	});

	it("never completes the server's last step before the server has answered", () => {
		for (const elapsedMs of [7400, 20_000, 600_000]) {
			const states = stepStates({ elapsedMs, sinceServerMs: null, workspaceShown: true });
			expect(states[SERVER_LAST]).toBe("active");
			expect(states[LAST]).toBe("idle");
		}
	});

	it("finishes every step the server's answer stands for, even ahead of their timers", () => {
		const states = stepStates({ elapsedMs: 300, sinceServerMs: 0, workspaceShown: false });
		expect(states.slice(0, LAST).every((state) => state === "done")).toBe(true);
		expect(states[LAST]).toBe("active");
	});

	it("completes the last step only once the workspace has shown", () => {
		const waiting = stepStates({ elapsedMs: 8000, sinceServerMs: 500, workspaceShown: false });
		expect(waiting[LAST]).toBe("active");
		const shown = stepStates({ elapsedMs: 8000, sinceServerMs: 500, workspaceShown: true });
		expect(shown.every((state) => state === "done")).toBe(true);
	});

	it("gives up waiting for the workspace after the cap", () => {
		const before = stepStates({
			elapsedMs: 20_000,
			sinceServerMs: WORKSPACE_WAIT_CAP_MS - 1,
			workspaceShown: false,
		});
		expect(before[LAST]).toBe("active");
		const after = stepStates({
			elapsedMs: 20_000,
			sinceServerMs: WORKSPACE_WAIT_CAP_MS,
			workspaceShown: false,
		});
		expect(after[LAST]).toBe("done");
	});

	it("has at most one active step, and nothing but idle steps after it", () => {
		for (const elapsedMs of [0, 1000, 2500, 4500, 6500, 9000]) {
			for (const sinceServerMs of [null, 0, 1000, 6000]) {
				for (const workspaceShown of [false, true]) {
					const states = stepStates({ elapsedMs, sinceServerMs, workspaceShown });
					expect(states).toHaveLength(OPENING_STEPS.length);
					expect(states.filter((state) => state === "active").length).toBeLessThanOrEqual(1);
					const firstNotDone = states.findIndex((state) => state !== "done");
					if (firstNotDone !== -1) {
						expect(states.slice(firstNotDone + 1).every((state) => state === "idle")).toBe(true);
					}
				}
			}
		}
	});
});

describe("the demo bar's countdown", () => {
	const created = Date.UTC(2026, 10, 14, 12, 0, 0);
	const at = (ms: number) => created + ms;
	const minute = 60_000;
	const hour = 60 * minute;

	it("uses the day cleanup allows a sandbox", () => {
		expect(SANDBOX_LIFETIME_MS).toBe(24 * hour);
	});

	it("counts whole hours while there is an hour or more", () => {
		expect(deletionLabel(created, at(0))).toBe("Deleted in 24 h");
		expect(deletionLabel(created, at(30 * minute))).toBe("Deleted in 23 h");
		expect(deletionLabel(created, at(23 * hour))).toBe("Deleted in 1 h");
	});

	it("counts minutes in the last hour, rounding up", () => {
		expect(deletionLabel(created, at(23 * hour + 1))).toBe("Deleted in 60 min");
		expect(deletionLabel(created, at(23 * hour + 30 * minute))).toBe("Deleted in 30 min");
		expect(deletionLabel(created, at(24 * hour - 1000))).toBe("Deleted in 1 min");
	});

	it("says soon once the day is up, since cleanup runs every ten minutes", () => {
		expect(deletionLabel(created, at(24 * hour))).toBe("Deleted soon");
		expect(deletionLabel(created, at(30 * hour))).toBe("Deleted soon");
	});
});
