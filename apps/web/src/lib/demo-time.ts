import { SANDBOX_LIFETIME_MS } from "#/lib/demo-lifetime";

/**
 * How long until cleanup deletes the sandbox, as the demo bar says it. Cleanup deletes visitors
 * a day after they were made and runs every ten minutes, so past the day it is "soon".
 */
export function deletionLabel(createdAt: number, now: number): string {
	const left = createdAt + SANDBOX_LIFETIME_MS - now;
	if (left <= 0) return "Deleted soon";
	const hours = Math.floor(left / 3_600_000);
	if (hours >= 1) return `Deleted in ${hours} h`;
	return `Deleted in ${Math.max(1, Math.ceil(left / 60_000))} min`;
}
