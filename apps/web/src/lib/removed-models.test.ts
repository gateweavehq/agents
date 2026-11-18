import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WORKERS_AI_REMOVED } from "@gateweave/agents-model";
import { expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");

/** What ships or is read: the code, the docs, the setups and the settings. */
const PLACES = [
	"apps",
	"packages",
	"docs",
	"setups",
	"scripts",
	"sandbox",
	"README.md",
	"wrangler.jsonc",
	".dev.vars.example",
];
const SKIPPED = new Set([
	"node_modules",
	"dist",
	".output",
	".wrangler",
	".tanstack",
	"coverage",
	// Wrangler's generated types, which are not committed, name every model its `AI` binding knew.
	"worker-configuration.d.ts",
]);
const TEXT =
	/\.(?:[cm]?[jt]sx?|json|jsonc|md|mdx|ya?ml|toml|sql|sh|example)$|(?:^|[\\/])Dockerfile$/;
/** The list itself, which has to name them. Tests may too, to show what a removed model does. */
const LIST = "packages/model/src/workers-ai.ts";
const TESTS = /(?:^|\/)(?:test|e2e|smoke)\/|\.test\.tsx?$/;

function files(path: string): string[] {
	if (!statSync(path).isDirectory()) return [path];
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => !SKIPPED.has(entry.name))
		.flatMap((entry) => files(join(path, entry.name)));
}

// Cloudflare removes Workers AI models with a few weeks' notice. When it does, add them to
// `WORKERS_AI_REMOVED`, and this says where the product still names one: a default, a suggestion,
// a price, a page of the docs.
it("names no model Cloudflare removed from Workers AI, anywhere it offers or recommends one", () => {
	const removed = Object.keys(WORKERS_AI_REMOVED);
	expect(removed).toContain("@cf/moonshotai/kimi-k2.6");
	const read = PLACES.flatMap((place) => files(join(ROOT, place)))
		.map((path) => ({ path, name: relative(ROOT, path).replaceAll("\\", "/") }))
		.filter(({ name }) => TEXT.test(name) && name !== LIST && !TESTS.test(name));
	// The walk found the repository, not an empty folder.
	expect(read.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			"packages/model/src/prices.ts",
			"docs/track-triage.md",
			"apps/web/src/components/registry/track-connect-step.tsx",
		]),
	);
	const found: string[] = [];
	for (const { path, name } of read) {
		const text = readFileSync(path, "utf8");
		for (const model of removed) {
			// An id that only begins like a removed one is another model (`…-fp8` and `…-fp8-fast`).
			for (let at = text.indexOf(model); at !== -1; at = text.indexOf(model, at + 1)) {
				if (/[\w.-]/.test(text[at + model.length] ?? "")) continue;
				found.push(`${name}: ${model}`);
				break;
			}
		}
	}
	expect(found).toEqual([]);
});
