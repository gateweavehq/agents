import type { ChecksSet } from "@gateweave/agents-registry";

/** A digest keeps commands out of the audit log while identifying the saved list on a retry. */
export async function checksDigest(checks: string[]): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(checks)),
	);
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function saveChecksWithAudit(
	checks: string[],
	save: () => Promise<ChecksSet | null>,
	latestDigest: () => Promise<string | null>,
	audit: (set: ChecksSet, digest: string) => Promise<void>,
): Promise<string[] | null> {
	const set = await save();
	if (!set) return null;
	const same =
		set.before.length === set.checks.length &&
		set.before.every((command, index) => command === set.checks[index]);
	const digest = await checksDigest(checks);
	if (!same || (await latestDigest()) !== digest) {
		await audit(set, digest);
	}
	return set.checks;
}
