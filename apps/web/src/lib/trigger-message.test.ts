import { triggerMessage } from "@gateweave/agents-model";
import { expect, it } from "vitest";
import {
	describeEvent,
	isMarkedTriggerMessage,
	prettyEvent,
	readTriggerMessage,
} from "./trigger-message";

const PROMPT =
	'Track sent {{type}} for the issue {{data.issue.key}}, "{{data.issue.title}}", in the workspace "{{data.workspace.slug}}". It is assigned to you: work on it as your instructions say.';

function event(type: string, extra: Record<string, unknown> = {}) {
	return JSON.stringify({
		type,
		timestamp: "2026-11-14T21:18:42.897Z",
		data: {
			workspace: { id: "w1", slug: "gateweave" },
			actor: { id: "u1", name: "Maya", type: "person" },
			issue: {
				id: "i1",
				key: "TRK-137",
				title: "Roadmap: list feature flags",
				url: "https://track.example.com/gateweave/issue/TRK-137",
				description: "A `code` span\n\n```ts\nconst a = 1;\n```\n",
			},
			...extra,
		},
	});
}

const NOTE =
	"This run's page, where people can follow your work in Gateweave Agents: https://a.example/x/runs/1";

it("reads the message a delivery makes, with the note the runtime adds after it", () => {
	const body = event("issue.created");
	const text = `${triggerMessage(PROMPT, body)}\n\n${NOTE}`;
	const read = readTriggerMessage(text);
	expect(read?.body).toBe(body);
	expect(read?.prompt).toContain("Track sent issue.created for the issue TRK-137");
	expect(read?.after).toBe(NOTE);
});

it("reads a body that holds fences, and one that is not JSON", () => {
	const body = event("issue.created");
	expect(body).toContain("```");
	expect(readTriggerMessage(triggerMessage(PROMPT, body))?.body).toBe(body);
	expect(readTriggerMessage(triggerMessage("Look", "not json\nat all"))?.body).toBe(
		"not json\nat all",
	);
});

it("leaves alone text that only resembles a delivery's message", () => {
	const intro = "x\n\nThe event, as it was sent:\n\n```";
	expect(readTriggerMessage("Please fix the login page.")).toBeNull();
	expect(readTriggerMessage(`${intro}yaml\na: 1\n\`\`\``)).toBeNull();
	expect(readTriggerMessage(`${intro}json\n{}`)).toBeNull();
	expect(readTriggerMessage(`${intro}json\n{}\n\`\`\`trailing`)).toBeNull();
});

it("knows a message by the marker the runtime stores", () => {
	expect(isMarkedTriggerMessage({ metadata: { source: "trigger" } })).toBe(true);
	expect(isMarkedTriggerMessage({ metadata: { source: "person" } })).toBe(false);
	expect(isMarkedTriggerMessage({ metadata: undefined })).toBe(false);
	expect(isMarkedTriggerMessage({ metadata: "trigger" })).toBe(false);
});

it("says each Track event in words, with the issue, the actor and the time", () => {
	const words = {
		"issue.created": "Track: issue created",
		"issue.updated": "Track: issue changed",
		"comment.created": "Track: comment added",
		"issue.deleted": "Track: issue deleted",
		"proposal.accepted": "Track: proposal accepted",
	};
	for (const [type, title] of Object.entries(words)) {
		expect(describeEvent(event(type)).title).toBe(title);
	}
	expect(describeEvent(event("issue.created"))).toEqual({
		source: "track",
		title: "Track: issue created",
		type: "issue.created",
		issue: {
			key: "TRK-137",
			title: "Roadmap: list feature flags",
			url: "https://track.example.com/gateweave/issue/TRK-137",
		},
		actor: "Maya",
		at: Date.parse("2026-11-14T21:18:42.897Z"),
	});
});

it("links an issue only to an http(s) address, and does without an actor", () => {
	const body = JSON.stringify({
		type: "issue.updated",
		data: {
			workspace: { slug: "w" },
			issue: { key: "A-1", title: "T", url: "javascript:alert(1)" },
		},
	});
	const view = describeEvent(body);
	expect(view.issue).toEqual({ key: "A-1", title: "T", url: null });
	expect(view.actor).toBeNull();
	expect(view.at).toBeNull();
});

it("shows a schedule and an unknown sender generically", () => {
	const schedule = JSON.stringify({
		type: "schedule",
		timestamp: "2026-11-14T08:00:00.000Z",
		data: { scheduledFor: "2026-11-14T08:00:00.000Z", cron: "0 8 * * *" },
	});
	expect(describeEvent(schedule, "Morning sweep")).toMatchObject({
		source: "schedule",
		title: "Schedule: Morning sweep",
		at: Date.parse("2026-11-14T08:00:00.000Z"),
	});
	expect(describeEvent('{"type":"deploy.finished","data":{}}', "Deploys")).toMatchObject({
		source: "other",
		title: "Deploys",
		type: "deploy.finished",
	});
	expect(describeEvent("not json")).toMatchObject({
		source: "other",
		title: "Trigger",
		type: null,
	});
	expect(describeEvent("null").source).toBe("other");
});

it("pretty-prints with two spaces, and shows text that is not JSON as it came", () => {
	expect(prettyEvent('{"a":[1,2],"b":{"c":"d"}}')).toBe(
		'{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": "d"\n  }\n}',
	);
	expect(prettyEvent("{not json")).toBe("{not json");
	expect(prettyEvent("")).toBe("");
});
