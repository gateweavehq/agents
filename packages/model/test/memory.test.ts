import { expect, it } from "vitest";
import {
	agentDefinitionInput,
	MEMORY_LIMITS,
	memoryEditInput,
	memoryExcerpt,
	memoryInput,
	memoryMatch,
	memoryWords,
	recallInput,
	rememberInput,
} from "../src";

it("reads a query as its words, and nothing else of it", () => {
	expect(memoryWords("Which database does the Storefront use?")).toEqual([
		"Which",
		"database",
		"does",
		"the",
		"Storefront",
		"use",
	]);
	// Words stay as they were typed, marks and case included: the index's tokenizer folds them,
	// the same way it folded the memories. Everything that is not a letter or a digit goes.
	expect(memoryWords("Résumé İstanbul  Größe")).toEqual(["Résumé", "İstanbul", "Größe"]);
	expect(memoryWords("re\u0301sume\u0301 \u0301x")).toEqual(["re\u0301sume\u0301"]);
	expect(memoryWords("हमारा डेटाबेस")).toEqual(["हमारा", "डेटाबेस"]);
	expect(memoryWords("قَاعِدَةُ البَيَانَاتِ")).toEqual(["قَاعِدَةُ", "البَيَانَاتِ"]);
	// One Latin, Greek or Cyrillic letter is no word, such as what an apostrophe cuts off. One
	// character of another script can be, and so can a digit.
	expect(memoryWords("can't don't I'm O'Neil é я ω")).toEqual(["can", "don", "Neil"]);
	expect(memoryWords("数 と 한 ह 7")).toEqual(["数", "と", "한", "ह", "7"]);
	expect(memoryWords('"deploy" OR text:* NEAR(a, 2) -x ^y {z}')).toEqual([
		"deploy",
		"OR",
		"text",
		"NEAR",
		"2",
	]);
	expect(memoryWords("\"; '--*()")).toEqual([]);
	expect(memoryWords(Array.from({ length: 40 }, (_, index) => `w${index}`).join(" "))).toHaveLength(
		MEMORY_LIMITS.queryWords,
	);
});

it("writes a query as quoted prefix terms, so no query is FTS5 syntax", () => {
	expect(memoryMatch("deploy tuesdays", "any")).toBe('"deploy"* OR "tuesdays"*');
	expect(memoryMatch("deploy tuesdays", "all")).toBe('"deploy"* AND "tuesdays"*');
	expect(memoryMatch('deploy" OR text:*', "any")).toBe('"deploy"* OR "OR"* OR "text"*');
	expect(memoryMatch("NOT near AND", "all")).toBe('"NOT"* AND "near"* AND "AND"*');
	// "can't" is "can": a lone "t" would match every word that starts with one.
	expect(memoryMatch("can't deploy", "any")).toBe('"can"* OR "deploy"*');
	expect(memoryMatch("t", "any")).toBeNull();
	// A digit alone matches itself, not every number that starts with it.
	expect(memoryMatch("version 2", "all")).toBe('"version"* AND "2"');
	expect(memoryMatch("Postgres 17", "all")).toBe('"Postgres"* AND "17"*');
	expect(memoryMatch("?!", "any")).toBeNull();
	expect(memoryMatch("", "all")).toBeNull();
	// Whatever goes in, what comes out is quoted words, stars and the one operator.
	const queries = [
		'"',
		'""""',
		'ab"cd',
		"(((",
		"xx:yy",
		"* * *",
		"ab\u0000cd",
		"'; DROP TABLE xx",
		"re\u0301sume\u0301",
		'डेटा"बेस',
	];
	for (const query of queries) {
		expect(memoryMatch(query, "any") ?? "", query).toMatch(
			/^("[\p{L}\p{N}][\p{L}\p{N}\p{M}]*"\*?( OR "[\p{L}\p{N}][\p{L}\p{N}\p{M}]*"\*?)*)?$/u,
		);
	}
});

it("keeps the start of a memory for the audit log, and nothing of one about a person", () => {
	const text = `Deploys   go out\non Tuesdays, ${"after the team's review ".repeat(10)}`;
	const excerpt = memoryExcerpt({ text, scope: "workspace" });
	expect(excerpt).toHaveLength(MEMORY_LIMITS.excerpt);
	expect(excerpt?.startsWith("Deploys go out on Tuesdays, after")).toBe(true);
	expect(excerpt?.endsWith("…")).toBe(true);
	expect(memoryExcerpt({ text: " Short. ", scope: "agent" })).toBe("Short.");
	expect(memoryExcerpt({ text: "Ada wants short answers.", scope: "person" })).toBeNull();
});

it("takes a memory of up to 2,000 characters about the workspace or one named thing", () => {
	expect(memoryInput.parse({ text: "  The API is written in Rust.  ", kind: "fact" })).toEqual({
		text: "The API is written in Rust.",
		kind: "fact",
		scope: "workspace",
		scopeId: null,
		sourceLabel: null,
		sourceUrl: null,
		expiresAt: null,
	});
	const refused = (input: unknown) => memoryInput.safeParse(input).success === false;
	expect(refused({ text: "   ", kind: "fact" })).toBe(true);
	expect(refused({ text: "x".repeat(MEMORY_LIMITS.text + 1), kind: "fact" })).toBe(true);
	expect(refused({ text: "x".repeat(MEMORY_LIMITS.text), kind: "fact" })).toBe(false);
	expect(refused({ text: "x", kind: "rumor" })).toBe(true);
	// About an agent, a repository or a person means naming which; about the workspace, none.
	expect(refused({ text: "x", kind: "fact", scope: "agent" })).toBe(true);
	expect(refused({ text: "x", kind: "fact", scope: "workspace", scopeId: "a-1" })).toBe(true);
	expect(refused({ text: "x", kind: "fact", scope: "agent", scopeId: "a-1" })).toBe(false);
	// A source's link is https, so it is never a script.
	expect(refused({ text: "x", kind: "fact", sourceUrl: "javascript:alert(1)" })).toBe(true);
	expect(refused({ text: "x", kind: "fact", sourceUrl: "http://example.com" })).toBe(true);
	expect(refused({ text: "x", kind: "fact", sourceUrl: "https://example.com/notes" })).toBe(false);
	expect(
		memoryEditInput.parse({ id: "m-1", text: "x", kind: "fact", sourceLabel: " " }),
	).toMatchObject({ sourceLabel: null });
});

it("gives an agent's note its own scope unless it names another, and memory to no agent unasked", () => {
	expect(rememberInput.parse({ text: "x", kind: "fact" }).scope).toBe("agent");
	expect(recallInput.parse({ query: "" })).toEqual({
		query: "",
		scope: null,
		limit: MEMORY_LIMITS.recallDefault,
	});
	expect(
		agentDefinitionInput.parse({
			name: "Scout",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
		}).memory,
	).toBe(false);
});
