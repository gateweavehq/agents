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
/** The prices, which may keep a removed model's until its day, in an entry that says `until`. */
const PRICES = "packages/model/src/prices.ts";
const TESTS = /(?:^|\/)(?:test|e2e|smoke)\/|\.test\.tsx?$/;

/**
 * Where `text` names `model`. An id that goes on is another model (`…-fp8-fast`, `…-k2.6.1`); a
 * period that ends a sentence, before a space, a quote, a bracket or the end, is not part of one.
 */
function namings(text: string, model: string): number[] {
	const found: number[] = [];
	for (let at = text.indexOf(model); at !== -1; at = text.indexOf(model, at + 1)) {
		const next = text[at + model.length] ?? "";
		const after = text[at + model.length + 1] ?? "";
		if (/[\w-]/.test(next)) continue;
		if (next === "." && !/^$|[\s"'`)\]}>]/.test(after)) continue;
		found.push(at);
	}
	return found;
}

/** Whether the prices entry that begins at `at` ends on a day, as a removed model's must. */
function ends(text: string, at: number): boolean {
	return text.slice(at, text.indexOf("}", at)).includes("until:");
}

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
			const at = namings(text, model).filter((place) => name !== PRICES || !ends(text, place));
			if (at.length > 0) found.push(`${name}: ${model}`);
		}
	}
	expect(found).toEqual([]);
});

it("finds a removed model at the end of a sentence, and not another model that begins like it", () => {
	const kimi = "@cf/moonshotai/kimi-k2.6";
	expect(namings(`Use ${kimi}. It triages well.`, kimi)).toEqual([4]);
	expect(namings(`Use ${kimi}.`, kimi)).toEqual([4]);
	expect(namings(`(\`${kimi}\`), "${kimi}." and (${kimi}.)`, kimi)).toHaveLength(3);
	expect(namings(`${kimi}-fast, ${kimi}.1 and ${kimi}_x`, kimi)).toEqual([]);
	expect(namings(`${kimi}.1, then ${kimi}`, kimi)).toHaveLength(1);
	// In the prices, only an entry that ends on a day may name one.
	const priced = `"${kimi}": { input: 1, until: "2026-11-20" },\n"${kimi}": { input: 1 },`;
	expect(namings(priced, kimi).map((place) => ends(priced, place))).toEqual([true, false]);
});
