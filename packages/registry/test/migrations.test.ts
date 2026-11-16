import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/migrations.js";

const { entries } = migrations.journal;

describe("the registry's migrations", () => {
	// The migrator runs a migration only when its `when` is later than the newest one a registry
	// has noted. One dated at or before the migration ahead of it, as a clock set back or a
	// regenerated file can leave it, would run on new registries and be skipped on every
	// existing one, with no error until something reads what it should have made.
	it("are each dated later than the one before, so no registry skips one", () => {
		expect(entries.length).toBeGreaterThan(0);
		const late = entries.filter(
			(entry, index) => index > 0 && !(entry.when > (entries[index - 1]?.when ?? Infinity)),
		);
		expect(late.map(({ tag }) => tag)).toEqual([]);
	});

	it("are numbered in order, each with its statements", () => {
		expect(entries.map(({ idx }) => idx)).toEqual(entries.map((_, index) => index));
		expect(new Set(entries.map(({ tag }) => tag)).size).toBe(entries.length);
		for (const { idx, tag } of entries) {
			const statements = migrations.migrations[`m${String(idx).padStart(4, "0")}`];
			expect(statements, tag).toEqual(expect.any(String));
			expect(tag.startsWith(String(idx).padStart(4, "0")), tag).toBe(true);
		}
	});

	it("are each noted by a new registry under their own date, in order", async () => {
		const stub = env.REGISTRY.getByName(crypto.randomUUID());
		await stub.listProjects();
		const noted = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ created_at: number }>("SELECT created_at FROM __drizzle_migrations ORDER BY rowid")
				.toArray()
				.map((row) => Number(row.created_at)),
		);
		expect(noted).toEqual(entries.map(({ when }) => when));
	});
});
