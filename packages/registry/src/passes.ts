/**
 * One-time passes over a workspace's own data, for what a SQL migration cannot express. Each runs
 * as the registry wakes, after its migrations, in a write of its own, and is recorded in
 * `registry_passes` so it never runs again, whether it worked or not.
 */
import { eq } from "drizzle-orm";
import { registryPasses } from "./db/schema";
import type { Db } from "./state";

/** Room for an error's message in `registry_passes.failure`. */
const MAX_FAILURE = 1_000;

/**
 * Runs `pass` once in this workspace. It runs in a write, which `write` opens, and is recorded in
 * the same one. If it throws, the write rolls back and the failure is recorded in another, so a
 * pass that cannot work does not stop the registry from waking, or run again on every wake. A
 * pass that failed leaves its work undone; the log and `registry_passes` say why.
 */
export function runPassOnce(
	db: Db,
	write: <T>(fn: () => T) => T,
	name: string,
	pass: () => void,
	now: number = Date.now(),
): void {
	try {
		write(() => {
			if (passRecorded(db, name)) return;
			pass();
			db.insert(registryPasses).values({ name, ranAt: now, failure: null }).run();
		});
	} catch (error) {
		const failure = (error instanceof Error ? error.message : String(error)).slice(0, MAX_FAILURE);
		console.error(`registry: the one-time pass ${name} failed and will not run again`, failure);
		try {
			write(() => {
				db.insert(registryPasses).values({ name, ranAt: now, failure }).onConflictDoNothing().run();
			});
		} catch (again) {
			// It runs again on the next wake, then; the registry still wakes.
			console.error(`registry: recording that ${name} failed failed`, String(again));
		}
	}
}

function passRecorded(db: Db, name: string): boolean {
	return (
		db
			.select({ name: registryPasses.name })
			.from(registryPasses)
			.where(eq(registryPasses.name, name))
			.get() !== undefined
	);
}
