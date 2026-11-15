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
		"which",
		"database",
		"does",
		"the",
		"storefront",
		"use",
	]);
	// Accents go, as the index drops them, and so does everything that is not a letter or a digit.
	expect(memoryWords("Résumé İstanbul  Größe")).toEqual(["resume", "istanbul", "große"]);
	expect(memoryWords('"deploy" OR text:* NEAR(a, 2) -x ^y {z}')).toEqual([
		"deploy",
		"or",
		"text",
		"near",
		"a",
		"2",
		"x",
		"y",
		"z",
	]);
	expect(memoryWords("\"; '--*()")).toEqual([]);
	expect(memoryWords(Array.from({ length: 40 }, (_, index) => `w${index}`).join(" "))).toHaveLength(
		MEMORY_LIMITS.queryWords,
	);
});

it("writes a query as quoted prefix terms, so no query is FTS5 syntax", () => {
	expect(memoryMatch("deploy tuesdays", "any")).toBe('"deploy"* OR "tuesdays"*');
	expect(memoryMatch("deploy tuesdays", "all")).toBe('"deploy"* AND "tuesdays"*');
	expect(memoryMatch('deploy" OR text:*', "any")).toBe('"deploy"* OR "or"* OR "text"*');
	expect(memoryMatch("NOT near AND", "all")).toBe('"not"* AND "near"* AND "and"*');
	expect(memoryMatch("?!", "any")).toBeNull();
	expect(memoryMatch("", "all")).toBeNull();
	// Whatever goes in, what comes out is quoted words, stars and the one operator.
	for (const query of ['"', '""""', 'a"b', "(((", "x:y", "* * *", "a\u0000b", "'; DROP TABLE x"]) {
		expect(memoryMatch(query, "any") ?? "").toMatch(
			/^("[\p{L}\p{N}]+"\*( OR "[\p{L}\p{N}]+"\*)*)?$/u,
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
