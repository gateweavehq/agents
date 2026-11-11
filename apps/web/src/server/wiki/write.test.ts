import type { WikiPageContext, WikiPlanContext } from "@gateweave/agents-registry";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { jsonIn, planWiki, tidyPage, WikiAnswerError, writeWikiPage } from "./write";

/** A model that answers every request with `text`, and keeps what it was asked. */
function answering(text: string) {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: { unified: "stop", raw: "end_turn" },
			usage: {
				inputTokens: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
				outputTokens: { total: 300, text: 300, reasoning: 0 },
			},
			warnings: [],
		}),
	});
}

function prompt(model: MockLanguageModelV4): string {
	return JSON.stringify(model.doGenerateCalls[0]?.prompt ?? []);
}

const model = { provider: "anthropic" as const, model: "claude-sonnet-5-5", key: "not-a-key" };

function planContext(overrides: Partial<WikiPlanContext> = {}): WikiPlanContext {
	return {
		repository: { owner: "acme", name: "app" },
		commit: "c".repeat(40),
		listing: [
			{ path: "README.md", size: 100 },
			{ path: "src/sync.ts", size: 2000 },
			{ path: "src/store.ts", size: 1500 },
		],
		truncated: false,
		docs: [{ path: "README.md", text: "# App\nIt syncs." }],
		steering: null,
		model,
		...overrides,
	};
}

describe("planning", () => {
	it("keeps the pages the model plans, with files the repository has", async () => {
		const llm = answering(
			`Here is the plan:\n\`\`\`json\n${JSON.stringify({
				pages: [
					{ title: "Overview", purpose: "What it is", parent: null, files: ["README.md"] },
					{
						title: "Sync",
						purpose: "How it syncs",
						parent: "Overview",
						files: ["src/sync.ts", "src/missing.ts", "./src/store.ts"],
					},
					{ title: "Sync", purpose: "Again", parent: null, files: [] },
					{ title: "Store", purpose: "", parent: "Nowhere", files: [] },
				],
			})}\n\`\`\``,
		);
		const { plan, tokens } = await planWiki(llm, planContext());
		expect(plan.steered).toBe(false);
		expect(plan.pages).toEqual([
			{ title: "Overview", purpose: "What it is", parent: null, notes: [], files: ["README.md"] },
			{
				title: "Sync",
				purpose: "How it syncs",
				parent: "Overview",
				notes: [],
				files: ["src/sync.ts", "src/store.ts"],
			},
			// No files: it reads the docs planning read.
			{ title: "Store", purpose: "Store", parent: null, notes: [], files: ["README.md"] },
		]);
		expect(tokens).toEqual({ input: 1000, output: 300, cacheRead: 200, cacheWrite: 0 });
		expect(prompt(llm)).toContain("src/sync.ts 2000");
	});

	it("keeps the steering file's pages exactly, with the files the model chose", async () => {
		const steering = JSON.stringify({
			repo_notes: [{ content: "Follow docs/architecture.md." }],
			pages: [
				{ title: "Overview", purpose: "The product" },
				{
					title: "Sync",
					purpose: "The sync engine",
					parent: "Overview",
					page_notes: [{ content: "Cite the oplog." }],
				},
			],
		});
		const llm = answering(
			JSON.stringify({
				pages: [
					{ title: "overview", purpose: "ignored", files: ["README.md"] },
					{ title: "Sync", purpose: "ignored", files: ["src/sync.ts"] },
					{ title: "Extra", purpose: "not asked for", files: [] },
				],
			}),
		);
		const { plan } = await planWiki(llm, planContext({ steering }));
		expect(plan).toEqual({
			steered: true,
			steeringProblem: null,
			notes: ["Follow docs/architecture.md."],
			pages: [
				{
					title: "Overview",
					purpose: "The product",
					parent: null,
					notes: [],
					files: ["README.md"],
				},
				{
					title: "Sync",
					purpose: "The sync engine",
					parent: "Overview",
					notes: ["Cite the oplog."],
					files: ["src/sync.ts"],
				},
			],
		});
		expect(prompt(llm)).toContain("Keep exactly these pages");
	});

	it("plans on its own when the steering file breaks a rule, and says why", async () => {
		const llm = answering(JSON.stringify({ pages: [{ title: "Overview", files: [] }] }));
		const { plan } = await planWiki(llm, planContext({ steering: '{"pages": []}' }));
		expect(plan.steered).toBe(false);
		expect(plan.steeringProblem).toMatch(/^\.devin\/wiki\.json breaks a rule/);
	});

	it("fails a plan that is not JSON in the shape asked for, so the step tries again", async () => {
		await expect(planWiki(answering("I cannot do that."), planContext())).rejects.toBeInstanceOf(
			WikiAnswerError,
		);
		await expect(
			planWiki(answering('{"pages": [{"purpose": "no title"}]}'), planContext()),
		).rejects.toBeInstanceOf(WikiAnswerError);
	});
});

describe("writing a page", () => {
	const context: WikiPageContext = {
		repository: { owner: "acme", name: "app" },
		commit: "c".repeat(40),
		page: { number: "2", title: "Sync", purpose: "How it syncs", notes: ["Cite the oplog."] },
		outline: [
			{ number: "1", title: "Overview", depth: 0 },
			{ number: "2", title: "Sync", depth: 0 },
		],
		notes: ["Follow docs/architecture.md."],
		files: [
			{ path: "src/sync.ts", text: "export function sync() {\n\treturn 1;\n}" },
			{ path: "logo.png", text: null },
		],
		model,
	};

	it("writes from the files with their line numbers, and lists what it read", async () => {
		const llm = answering(
			"```markdown\n# Sync\n\nIt syncs.\n\n**Sources:** [src/sync.ts:1-3]()\n```",
		);
		const { page } = await writeWikiPage(llm, context);
		expect(page.body).toBe("It syncs.\n\n**Sources:** [src/sync.ts:1-3]()");
		expect(page.sources).toEqual([{ path: "src/sync.ts", lines: 3 }]);
		const asked = prompt(llm);
		expect(asked).toContain("1\\texport function sync() {");
		expect(asked).toContain("Follow docs/architecture.md.");
		expect(asked).toContain("(for this page) Cite the oplog.");
		expect(asked).toContain("2 Sync  ← this page");
	});

	it("shows a long file only up to its budget, and says so", async () => {
		const long = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1}`).join("\n");
		const llm = answering("Body.");
		const { page } = await writeWikiPage(llm, {
			...context,
			files: [{ path: "src/long.ts", text: long }],
		});
		const shown = page.sources[0]?.lines ?? 0;
		expect(shown).toBeGreaterThan(1000);
		expect(shown).toBeLessThan(20_000);
		expect(prompt(llm)).toContain(`(lines 1-${shown} of 20000)`);
	});
});

describe("tidying a model's answer", () => {
	it("finds the JSON in words around it", () => {
		expect(jsonIn('Sure! {"pages": []} Hope that helps.')).toEqual({ pages: [] });
		expect(jsonIn("no json")).toBeNull();
	});

	it("drops a repeated title and a fence around the page, and nothing else", () => {
		expect(tidyPage("# Page: Sync\n\nText", "Sync")).toBe("Text");
		expect(tidyPage("# Other\n\nText", "Sync")).toBe("# Other\n\nText");
		expect(tidyPage("Text\n\n```ts\ncode\n```", "Sync")).toBe("Text\n\n```ts\ncode\n```");
	});
});
