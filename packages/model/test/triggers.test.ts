import { expect, it } from "vitest";
import {
	eventType,
	triggerInput,
	triggerMessage,
	triggerOf,
	triggerPatch,
	triggerSecret,
	triggerStarter,
} from "../src";

const EVENT = JSON.stringify({
	type: "issue.created",
	data: { title: "Login fails", labels: ["bug"], assignee: null },
});

it("fills the prompt from the event, and adds the event as it came", () => {
	const message = triggerMessage("Triage {{ data.title }} ({{data.labels}}).", EVENT);
	expect(message).toBe(
		`Triage Login fails (["bug"]).\n\nThe event, as it was sent:\n\n\`\`\`json\n${EVENT}\n\`\`\``,
	);
	// What the event does not hold is left out, prototype keys included.
	expect(triggerMessage("{{data.assignee}}|{{data.nope.deeper}}|{{constructor}}", EVENT)).toMatch(
		/^\|\|\n/,
	);
	expect(triggerMessage("Look at {{data}}", "not json")).toBe(
		"Look at \n\nThe event, as it was sent:\n\n```text\nnot json\n```",
	);
});

it("reads the event's type, when it has one", () => {
	expect(eventType(EVENT)).toBe("issue.created");
	expect(eventType(JSON.stringify({ type: 3 }))).toBeNull();
	expect(eventType("null")).toBeNull();
	expect(eventType("not json")).toBeNull();
});

it("names a trigger as the starter of its runs, and reads it back", () => {
	expect(triggerOf(triggerStarter("abc"))).toBe("abc");
	expect(triggerOf("user-ada")).toBeNull();
});

it("takes a sender's secret only as Standard Webhooks writes it", () => {
	const secret = "whsec_YSBzZW5kZXIncyBzZWNyZXQsIDMyIGJ5dGVzIGxvbmc=";
	expect(triggerSecret.parse(` ${secret} `)).toBe(secret);
	expect(triggerSecret.safeParse("whsec_short").success).toBe(false);
	expect(triggerSecret.safeParse(secret.replace("whsec_", "")).success).toBe(false);
});

it("starts on every event unless given event types, which it trims", () => {
	const input = {
		name: "New issues",
		prompt: "Triage it",
		target: { kind: "agent", agentId: "a" },
	};
	expect(triggerInput.parse(input).events).toBeNull();
	expect(triggerInput.parse({ ...input, events: [" issue.created "] }).events).toEqual([
		"issue.created",
	]);
	// A patch leaves the events alone, or sets them, or takes every event again.
	expect(triggerPatch.parse({}).events).toBeUndefined();
	expect(triggerPatch.parse({ events: null }).events).toBeNull();
	expect(
		triggerPatch.safeParse({
			events: Array(21)
				.fill(0)
				.map((_, i) => `e${i}`),
		}).error?.issues[0]?.message,
	).toBe("A trigger can start on up to 20 event types");
});
