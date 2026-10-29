import { expect, it } from "vitest";
import {
	eventType,
	labelSkip,
	nextScheduledRun,
	scheduleEvent,
	scheduleProblem,
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

const NOW = Date.parse("2026-10-29T12:00:00Z");
const target = { kind: "agent", agentId: "agent-1" } as const;

it("reads a schedule in its time zone, summer time or not", () => {
	const weekdays = { cron: "0 9 * * 1-5", timeZone: "Europe/Istanbul" };
	expect(new Date(nextScheduledRun(weekdays, NOW) ?? 0).toISOString()).toBe(
		"2026-10-30T06:00:00.000Z",
	);
	// New York leaves summer time on 1 November: 1:30 moves from 5:30 to 6:30 UTC.
	const nightly = { cron: "30 1 * * *", timeZone: "America/New_York" };
	const runs: string[] = [];
	for (let at = NOW, step = 0; step < 4; step++) {
		at = nextScheduledRun(nightly, at) ?? 0;
		runs.push(new Date(at).toISOString());
	}
	expect(runs).toEqual([
		"2026-10-30T05:30:00.000Z",
		"2026-10-31T05:30:00.000Z",
		"2026-11-01T05:30:00.000Z",
		"2026-11-02T06:30:00.000Z",
	]);
});

it("refuses schedules that are not five fields, never run, run too often or have no time zone", () => {
	const problem = (cron: string, timeZone = "UTC") => scheduleProblem({ cron, timeZone }, NOW);
	expect(problem("*/5 * * * *")).toBeNull();
	expect(problem("0 9 * * 1-5", "Europe/Istanbul")).toBeNull();
	expect(problem("0 9 * *")).toMatch(/^Write the schedule as a cron expression of five fields/);
	expect(problem("0 0 9 * * *")).toMatch(/five fields/);
	expect(problem("61 * * * *")).toMatch(/Invalid value for minute/);
	expect(problem("0 0 30 2 *")).toBe("This schedule never runs");
	expect(problem("*/2 * * * *")).toBe("A schedule can run at most every 5 minutes");
	// Every minute, but only on the first of the month.
	expect(problem("* * 1 * *")).toBe("A schedule can run at most every 5 minutes");
	expect(problem("0 9 * * *", "Mars/Olympus")).toMatch(/^Mars\/Olympus is not a time zone/);
});

it("takes a schedule or event types on a trigger, not both", () => {
	const schedule = { cron: "0 9 * * 1-5", timeZone: "Europe/Istanbul" };
	const base = { name: "Standup", prompt: "Sum up yesterday", target };
	expect(triggerInput.parse({ ...base, schedule })).toMatchObject({ schedule, events: null });
	expect(triggerInput.parse(base).schedule).toBeNull();
	expect(triggerInput.safeParse({ ...base, schedule, events: ["issue.created"] }).success).toBe(
		false,
	);
	expect(
		triggerInput.safeParse({ ...base, schedule: { cron: "* * * * *", timeZone: "UTC" } }).error
			?.issues[0],
	).toMatchObject({
		path: ["schedule", "cron"],
		message: "A schedule can run at most every 5 minutes",
	});
	expect(triggerPatch.safeParse({ schedule, events: ["issue.created"] }).success).toBe(false);
	expect(triggerPatch.parse({ schedule: null, events: ["issue.created"] })).toMatchObject({
		schedule: null,
	});
});

it("gives a schedule's run an event a prompt can read", () => {
	const schedule = { cron: "0 9 * * 1-5", timeZone: "Europe/Istanbul" };
	const at = Date.parse("2026-10-30T06:00:00Z");
	const event = scheduleEvent(schedule, at);
	expect(eventType(event)).toBe("schedule");
	expect(triggerMessage("Standup for {{data.scheduledFor}}", event)).toMatch(
		/^Standup for 2026-10-30T06:00:00\.000Z\n/,
	);
});

const AGENT = { id: "label-agent", name: "agent" };
const NOT_ABOUT_AN_ISSUE =
	"It starts runs only on issues labeled agent, and the event is not about an issue";

/** A Gateweave Track webhook body about one issue, with the issue's labels as of the event. */
function about(type: string, labels: unknown[], rest: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type,
		timestamp: "2026-10-29T12:00:00.000Z",
		data: { issue: { id: "TRK-1", title: "Login fails", labels }, ...rest },
	});
}

it("starts runs on issues with the label, in any case, and says why it skips the rest", () => {
	expect(labelSkip("agent", about("issue.created", [AGENT]))).toBeNull();
	expect(labelSkip(" Agent ", about("issue.created", [{ id: "x", name: "AGENT" }]))).toBeNull();
	expect(labelSkip("agent", about("issue.created", [{ id: "bug", name: "bug" }]))).toBe(
		"It starts runs only on issues labeled agent",
	);
	expect(labelSkip("agent", about("issue.created", []))).toBe(
		"It starts runs only on issues labeled agent",
	);
});

it("on issue.updated, starts only when the label was just added", () => {
	const added = about("issue.updated", [{ id: "bug", name: "bug" }, AGENT], {
		updatedFrom: { labelIds: ["bug"] },
	});
	expect(labelSkip("agent", added)).toBeNull();

	const kept = about("issue.updated", [AGENT], { updatedFrom: { labelIds: ["label-agent"] } });
	expect(labelSkip("agent", kept)).toBe("The label agent was on the issue already");

	// Only the title changed: no labels were touched, so nothing is added.
	const title = about("issue.updated", [AGENT], { updatedFrom: { title: "Login" } });
	expect(labelSkip("agent", title)).toBe("The label agent was on the issue already");
});

it("starts on a comment on a labeled issue, and skips an event that is not about an issue", () => {
	expect(labelSkip("agent", about("comment.created", [AGENT]))).toBeNull();
	expect(labelSkip("agent", JSON.stringify({ type: "proposal.created", data: {} }))).toBe(
		NOT_ABOUT_AN_ISSUE,
	);
	expect(labelSkip("agent", "not json")).toBe(NOT_ABOUT_AN_ISSUE);
	// Whatever the sender sent is checked before it is used.
	expect(labelSkip("agent", about("issue.created", ["agent"]))).toBe(
		"It starts runs only on issues labeled agent",
	);
	expect(labelSkip("agent", JSON.stringify({ data: { issue: null } }))).toBe(NOT_ABOUT_AN_ISSUE);
});

it("trims a trigger's label, refuses an empty one, and refuses one on a schedule", () => {
	const schedule = { cron: "0 9 * * 1-5", timeZone: "Europe/Istanbul" };
	const base = { name: "Agent issues", prompt: "Work on it", target };
	expect(triggerInput.parse({ ...base, label: " agent " })).toMatchObject({ label: "agent" });
	expect(triggerInput.parse(base).label).toBeNull();
	expect(triggerInput.safeParse({ ...base, label: "   " }).success).toBe(false);
	expect(triggerInput.safeParse({ ...base, label: "x".repeat(101) }).success).toBe(false);
	expect(
		triggerInput.safeParse({ ...base, schedule, label: "agent" }).error?.issues[0],
	).toMatchObject({
		path: ["label"],
		message: "A scheduled trigger starts on its schedule, not on labels",
	});
	expect(triggerPatch.parse({ label: " agent " }).label).toBe("agent");
	expect(triggerPatch.parse({ label: null }).label).toBeNull();
	expect(triggerPatch.safeParse({ schedule, label: "agent" }).success).toBe(false);
	expect(triggerPatch.safeParse({ schedule, label: null }).success).toBe(true);
});
