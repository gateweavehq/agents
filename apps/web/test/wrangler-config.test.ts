import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("what a deploy does to settings", () => {
	it("leaves alone what someone set in the dashboard", () => {
		// Wrangler otherwise removes a plain-text variable it does not find in this file, so the next
		// push would quietly take away a spending limit, or turn off email or a server's legal pages.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		expect(unstable_readConfig({ config }).keep_vars).toBe(true);
	});
});

describe("what a branch's Preview gets", () => {
	it("builds, with none of production's resources", () => {
		// Wrangler refuses to build a Preview without this block, which fails every push to a branch,
		// Dependabot's included.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		const { previews } = unstable_readConfig({ config });
		expect(previews).toBeDefined();
		expect(previews?.d1_databases ?? []).toEqual([]);
	});
});

describe("the public demo's environment", () => {
	// Anyone can open a sandbox there, so it binds nothing that sends, spends or runs code: no email,
	// no Workflow (wikis), no sandbox container, no Workers AI and no Analytics Engine. The code
	// refuses all of these on the demo too; this keeps the bindings from coming back unnoticed.
	const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
	const demo = unstable_readConfig({ config, env: "demo" });

	it("is a Worker of its own, marked as the demo, with its own database", () => {
		const production = unstable_readConfig({ config });
		expect(demo.name).toBe("gateweave-agents-demo");
		expect(demo.vars.AGENTS_DEMO).toBe("1");
		expect(production.vars.AGENTS_DEMO).toBeUndefined();
		expect(
			demo.d1_databases.map((database: { database_name?: string }) => database.database_name),
		).toEqual(["gateweave-agents-demo-eu"]);
		// Cleanup runs every ten minutes, so a sandbox lasts a day and a little.
		expect(demo.triggers.crons).toEqual(["*/10 * * * *"]);
	});

	it("binds nothing that sends email, writes wikis, runs sandboxes or asks a model", () => {
		expect(demo.send_email).toEqual([]);
		expect(demo.workflows).toEqual([]);
		expect(demo.containers ?? []).toEqual([]);
		expect(demo.ai).toBeUndefined();
		expect(demo.analytics_engine_datasets).toEqual([]);
		expect(
			demo.durable_objects.bindings.map((binding: { name: string }) => binding.name).sort(),
		).toEqual(["CONVERSATIONS", "RATE_LIMITER", "REGISTRY"]);
	});
});
