import { triggerMessage } from "@gateweave/agents-model";
import type { UIMessage } from "ai";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Transcript } from "./conversation-view";

const BODY = JSON.stringify({
	type: "issue.created",
	timestamp: "2026-11-14T21:18:42.897Z",
	data: {
		workspace: { id: "w1", slug: "gateweave" },
		actor: { id: "u1", name: "Maya", type: "person" },
		issue: {
			id: "i1",
			key: "TRK-137",
			title: "Roadmap: list feature flags",
			url: "https://track.example.com/gateweave/issue/TRK-137",
			description: `${"x".repeat(5000)}`,
		},
	},
});

const TEXT = triggerMessage('Track sent {{type}} for "{{data.issue.title}}".', BODY);

function render(messages: UIMessage[], triggerName: string | null = null) {
	return renderToString(
		createElement(Transcript, { messages, agentName: "Coder", members: null, triggerName }),
	);
}

const user = (text: string, metadata?: unknown): UIMessage => ({
	id: "m1",
	role: "user",
	metadata,
	parts: [{ type: "text", text }],
});

describe("a trigger's message", () => {
	it("is an event card with the event closed, not a person's bubble", () => {
		const html = render([user(TEXT, { source: "trigger" })]);
		expect(html).toContain("Track: issue created");
		expect(html).toContain('href="https://track.example.com/gateweave/issue/TRK-137"');
		expect(html).toContain("TRK-137 Roadmap: list feature flags");
		expect(html).toContain("By Maya");
		expect(html).toContain("The event as sent");
		expect(html).toMatch(/<details(?![^>]* open)/);
		// Pretty-printed in a code block that scrolls, not the fence as plain text.
		expect(html).toContain("&quot;type&quot;: &quot;issue.created&quot;");
		expect(html).toMatch(/<pre[^>]*overflow-auto/);
		expect(html).not.toContain("```");
		expect(html).not.toContain("rounded-2xl");
	});

	it("is recognised without the marker in a conversation stored before it, if it comes first", () => {
		expect(render([user(TEXT)])).toContain("Track: issue created");
		const later = render([user("hello"), user(TEXT)]);
		expect(later).not.toContain("Track: issue created");
	});

	it("shows a source the page does not know with the trigger's name", () => {
		const text = triggerMessage("Deploy finished.", '{"type":"deploy.finished","data":{}}');
		const html = render([user(text, { source: "trigger" })], "Deploys");
		expect(html).toContain("Deploys");
		expect(html).toContain("deploy.finished");
		expect(html).toContain("The event as sent");
	});

	it("falls back to Markdown for a marked message it cannot take apart", () => {
		const html = render([
			user("Look at `this`\n\n```ts\nconst a = 1;\n```", { source: "trigger" }),
		]);
		expect(html).toContain("<pre");
		expect(html).toContain("const a = 1;");
		expect(html).not.toContain("rounded-2xl");
	});

	it("keeps a person's message a plain bubble that wraps a long word", () => {
		const html = render([user("a".repeat(5000))]);
		expect(html).toContain("rounded-2xl");
		expect(html).toContain("overflow-wrap:anywhere");
	});
});

describe("tool chips", () => {
	it("say what each call acted on, in order, and keep the whole text in the title", () => {
		const call = (id: string, name: string, input: unknown) => ({
			type: `tool-${name}` as const,
			toolCallId: id,
			toolName: name,
			state: "output-available" as const,
			input,
			output: {},
		});
		const message = {
			id: "a1",
			role: "assistant",
			parts: [
				call("1", "read_file", { path: "docs/roadmap.md" }),
				call("2", "read_file", { path: "docs/architecture.md" }),
				call("3", "track__get_issue", { key: "TRK-137" }),
				call("4", "run_command", { command: "curl -H 'Authorization: Bearer abcdefghij' x" }),
			],
		} as UIMessage;
		const html = render([message]);
		expect(html.indexOf("docs/roadmap.md")).toBeLessThan(html.indexOf("docs/architecture.md"));
		expect(html).toContain('title="docs/roadmap.md"');
		expect(html).toContain("TRK-137");
		expect(html).toContain(">curl<");
		expect(html).not.toContain("abcdefghij");
	});
});
