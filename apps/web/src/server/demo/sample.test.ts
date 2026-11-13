import { type ModelSpan, scanResult } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import { type MadeAgent, pastHistory, sampleScan, sampleWiki } from "./sample";
import { DEMO_AGENTS, SAMPLE_REPOSITORIES, WIKI } from "./sample-data";

const NOW = Date.UTC(2026, 10, 13, 12);

function repository(key: string) {
	const found = SAMPLE_REPOSITORIES.find((each) => each.key === key);
	if (!found) throw new Error(`No sample repository ${key}`);
	return found;
}

function agents(): { lead: MadeAgent; reviewer: MadeAgent; writer: MadeAgent } {
	const made = (key: string): MadeAgent => {
		const agent = DEMO_AGENTS.find((each) => each.key === key);
		if (!agent) throw new Error(`No sample agent ${key}`);
		return { id: `agent-${key}`, agent };
	};
	return { lead: made("lead"), reviewer: made("reviewer"), writer: made("writer") };
}

describe("the sample repositories", () => {
	// What a visitor sees first is which coding agents work where, so each repository has to show
	// a different mix, read by the real adapters, and none of them a problem.
	it.each([
		["storefront", ["claude-code", "cursor"]],
		["payments", ["codex", "copilot", "gemini-cli"]],
		["mobile", ["claude-code", "copilot"]],
	])("scan %s as the scanner would, finding %j", (key, runtimes) => {
		const sample = repository(key);
		const scan = sampleScan({ ...sample.code, ...sample.agentFiles }, sample.commit, NOW);

		expect(scan.problems).toEqual([]);
		expect([...new Set(scan.agents.map((agent) => agent.runtime))].sort()).toEqual(runtimes);
		expect(scan.assets.length).toBeGreaterThan(0);
		// The registry takes it as it takes a real scan.
		expect(() => scanResult.parse(scan)).not.toThrow();
	});

	it("keep the agents' files, and not the code", () => {
		const sample = repository("storefront");
		const scan = sampleScan({ ...sample.code, ...sample.agentFiles }, sample.commit, NOW);
		const paths = scan.files.map((file) => file.path);
		expect(paths).toEqual(expect.arrayContaining(Object.keys(sample.agentFiles)));
		expect(paths).not.toContain("src/cart/cart.ts");
	});
});

describe("the sample history", () => {
	const history = pastHistory(agents(), "team-1", NOW);
	const traces = new Map(
		history.objects.flatMap((object) => object.runs.map((run) => [run.id, run])),
	);

	it("has a team conversation and one with each of two members, all in the past", () => {
		const topLevel = history.conversations.filter((conversation) => conversation.rootId === null);
		expect(topLevel).toHaveLength(3);
		expect(topLevel.filter((conversation) => conversation.teamId === "team-1")).toHaveLength(1);
		for (const conversation of history.conversations) {
			expect(conversation.updatedAt).toBeLessThan(NOW);
			expect(conversation.updatedAt).toBeGreaterThanOrEqual(conversation.startedAt);
		}
		// Each conversation's object gets its messages and its runs' traces.
		expect(history.objects.map((object) => object.conversationId).sort()).toEqual(
			history.conversations.map((conversation) => conversation.id).sort(),
		);
	});

	it("adds each run up from its trace, at list prices", () => {
		expect(history.runs).toHaveLength(5);
		for (const run of history.runs) {
			const trace = traces.get(run.id);
			expect(trace, run.id).toBeDefined();
			const models = (trace?.spans ?? []).filter(
				(span): span is ModelSpan => span.kind === "model",
			);
			const sum = (pick: (span: ModelSpan) => number) =>
				models.reduce((total, span) => total + pick(span), 0);
			expect(run.steps).toBe(models.length);
			expect(run.inputTokens).toBe(sum((span) => span.inputTokens));
			expect(run.outputTokens).toBe(sum((span) => span.outputTokens));
			expect(run.cachedInputTokens).toBe(sum((span) => span.cachedInputTokens));
			// Every sample model has a price, so no run is shown without a cost.
			expect(run.cost).not.toBeNull();
			expect(run.cost).toBeCloseTo(
				sum((span) => span.cost ?? Number.NaN),
				10,
			);
			for (const span of trace?.spans ?? []) {
				expect(span.startedAt).toBeGreaterThanOrEqual(run.startedAt);
				expect(span.endedAt ?? 0).toBeLessThanOrEqual(run.endedAt);
			}
		}
	});

	it("links each hand-off to the run it led to", () => {
		const nested = history.runs.filter((run) => run.parent !== null);
		expect(nested).toHaveLength(2);
		for (const run of nested) {
			const parent = traces.get(run.parent?.parentRunId ?? "");
			const edge = parent?.spans.find((span) => span.id === run.parent?.parentSpanId);
			expect(edge).toMatchObject({ kind: "edge", edge: "delegate", childRunId: run.id });
			expect(edge && "to" in edge ? edge.to : null).toBe(run.agentId);
		}
	});
});

describe("the sample wiki", () => {
	const storefront = repository("storefront");
	const wiki = sampleWiki("repository-1", storefront, NOW);
	const files: Record<string, string> = { ...storefront.code, ...storefront.agentFiles };

	it("reads files the repository has", () => {
		for (const page of WIKI.pages) {
			for (const path of page.files) expect(Object.keys(files), page.title).toContain(path);
		}
		expect(wiki.files.map((file) => file.path).sort()).toEqual(Object.keys(files).sort());
	});

	it("cites only lines that exist, in files the page read", () => {
		for (const page of WIKI.pages) {
			const citations = [...page.body.matchAll(/\[([^\]:]+):(\d+)(?:-(\d+))?\]\(\)/g)];
			expect(citations.length, page.title).toBeGreaterThan(0);
			for (const [citation, path = "", from = "", to] of citations) {
				expect(page.files, citation).toContain(path);
				const lines = (files[path] ?? "").replace(/\n$/, "").split("\n").length;
				const first = Number(from);
				const last = to ? Number(to) : first;
				expect(first, citation).toBeGreaterThanOrEqual(1);
				expect(last, citation).toBeGreaterThanOrEqual(first);
				expect(last, citation).toBeLessThanOrEqual(lines);
			}
		}
	});
});
