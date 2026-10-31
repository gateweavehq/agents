/**
 * Triggers: inbound webhooks that start a run of an agent run by Gateweave, or of a team, with no
 * person in the conversation. Each has its own URL and secret, and checks Standard Webhooks
 * signatures (https://www.standardwebhooks.com), which is what Gateweave Track sends. A trigger
 * can instead start runs on a schedule, and then takes no webhooks.
 */
import { Cron } from "croner";
import { z } from "zod";

/** How a delivery to a trigger went. */
export const TRIGGER_DELIVERY_STATUSES = [
	/** Taken, with its run about to begin. */
	"accepted",
	/** It started a run. */
	"started",
	/**
	 * The trigger was paused, or the event is not one it starts runs for, so it started nothing,
	 * and a retry starts nothing either.
	 */
	"skipped",
	/** Over the trigger's limits. A retry once there is room starts the run. */
	"limited",
	/** The run could not begin, such as with no key for the agent's provider. A retry may. */
	"failed",
] as const;
export type TriggerDeliveryStatus = (typeof TRIGGER_DELIVERY_STATUSES)[number];

export const TRIGGER_LIMITS = {
	/** Runs one trigger may start in a minute. */
	perMinute: 10,
	/** Runs a new trigger may start in a day, unless it is given another number. */
	defaultPerDay: 50,
	/** Most runs a trigger may be allowed in a day. */
	maxPerDay: 1000,
	/** Triggers a workspace may have. */
	perWorkspace: 50,
	/** Event types one trigger may be limited to. */
	events: 20,
	/** Largest body a trigger takes, in bytes. */
	bodyBytes: 64 * 1024,
	/** How far a delivery's timestamp may be from now, in seconds, as Standard Webhooks advises. */
	toleranceSeconds: 5 * 60,
	/** Deliveries each trigger shows. */
	shownDeliveries: 10,
	/** The shortest time between two runs of a schedule, in minutes. */
	scheduleMinutes: 5,
} as const;

/** A trigger's secret: `whsec_` and the base64 of its key, as Standard Webhooks writes them. */
export const TRIGGER_SECRET_PREFIX = "whsec_";

const STARTER_PREFIX = "trigger:";

/** Who starts a trigger's runs: no member, but the trigger, by its id. */
export function triggerStarter(triggerId: string): string {
	return `${STARTER_PREFIX}${triggerId}`;
}

/** The trigger a run's or conversation's starter names; null for a member. */
export function triggerOf(startedBy: string): string | null {
	return startedBy.startsWith(STARTER_PREFIX) ? startedBy.slice(STARTER_PREFIX.length) : null;
}

export type TriggerTarget = { kind: "agent"; agentId: string } | { kind: "team"; teamId: string };

/**
 * When a scheduled trigger starts a run: a cron expression of five fields (minute, hour, day of
 * the month, month, day of the week), read in an IANA time zone, so `0 9 * * 1-5` is 9:00 on
 * weekdays there, summer time or not.
 */
export interface TriggerSchedule {
	cron: string;
	timeZone: string;
}

export interface Trigger {
	id: string;
	name: string;
	/** What the agent is asked, with `{{path}}` filled in from the event. */
	prompt: string;
	target: TriggerTarget;
	/** The agent's or team's name; null once the agent was removed or the team deleted. */
	targetName: string | null;
	active: boolean;
	/** Runs it may start in a day. */
	perDay: number;
	/** The event types it starts runs for, by the `type` in the event's body; null is every event. */
	events: string[] | null;
	/**
	 * The issue label it starts runs for, by name: only issues that carry it, and on `issue.updated`
	 * only when it was just added (`labelSkip`). Null is no label filter.
	 */
	label: string | null;
	/**
	 * The Gateweave Track member it starts runs for, by id: only issues assigned to them, and on
	 * `issue.updated` only when they were just assigned (`assigneeSkip`). Null is no assignee filter.
	 */
	assignee: string | null;
	/**
	 * Whether it keeps one conversation per Gateweave Track issue (`issueOfEvent`): an event about an
	 * issue it already has a conversation for continues that one, with what was said and worked on
	 * there, its sandbox's branch and pull request included. An event about no issue starts a
	 * conversation of its own, as every event does when this is off.
	 */
	perIssue: boolean;
	/** When it starts runs on its own; null for a trigger that starts on webhooks. */
	schedule: TriggerSchedule | null;
	/** When its schedule starts the next run, while it is active; null otherwise. */
	nextRunAt: number | null;
	/** The start of its secret, to tell secrets apart. */
	secretStart: string;
	createdAt: number;
	updatedAt: number;
}

export interface TriggerDelivery {
	/** The sender's `webhook-id`, the same on every retry of one event. */
	id: string;
	triggerId: string;
	status: TriggerDeliveryStatus;
	/** The event's `type`, when its body has one. */
	event: string | null;
	runId: string | null;
	/** Why it started nothing, in the app's words. */
	error: string | null;
	receivedAt: number;
}

/** How beginning a trigger's run went: its run, or why it could not begin. */
export type TriggerTurnOutcome = { runId: string } | { runId: null; error: string };

/** The `type` of the event a schedule's run starts with (`scheduleEvent`). */
export const SCHEDULE_EVENT = "schedule";

/** A trigger with its latest deliveries, the newest first. */
export interface TriggerEntry extends Trigger {
	deliveries: TriggerDelivery[];
}

export interface TriggerRefusal {
	status: "refused";
	message: string;
}

/** The Standard Webhooks headers of a delivery. */
export interface TriggerHeaders {
	id: string;
	timestamp: string;
	signature: string;
}

/** What the registry made of a delivery, which the gateway answers the sender by. */
export type TriggerReceipt =
	/**
	 * Signed and within the limits: the run starts in this conversation, with this message. The
	 * conversation is new, or the one a per-issue trigger keeps for the event's issue.
	 */
	| { status: "start"; conversationId: string; text: string }
	/** A retry of a delivery that started a run, or was skipped. */
	| { status: "duplicate"; runId: string | null }
	/** A retry of a delivery whose run is starting now: the sender may ask again in `retryAfter`. */
	| { status: "starting"; retryAfter: number }
	/** The trigger is paused, or the event is not one it starts runs for. */
	| { status: "skipped" }
	/** Over a limit; the sender may try again in `retryAfter` seconds. */
	| { status: "limited"; retryAfter: number; message: string }
	/** Its agent or team cannot answer, or the server cannot keep secrets. */
	| { status: "refused"; message: string }
	/** The signature or timestamp does not hold. */
	| { status: "unauthorized" }
	| { status: "not_found" };

const name = z.string().trim().min(1, "Give it a name").max(80);
const prompt = z
	.string()
	.trim()
	.min(1, "Say what the agent should do with each event")
	.max(10_000, "Keep the prompt under 10,000 characters");
const perDay = z
	.number()
	.int()
	.min(1, "Allow at least one run a day")
	.max(
		TRIGGER_LIMITS.maxPerDay,
		`A trigger can start up to ${TRIGGER_LIMITS.maxPerDay} runs a day`,
	);
const id = z.string().min(1).max(64);

/**
 * The event types a trigger starts runs for, as Standard Webhooks senders name them in the body's
 * `type` (`issue.created`). Null is every event, and an event of another type, or with none, is
 * skipped. A sender that sends more than the job needs then costs no runs.
 */
export const triggerEvents = z
	.array(
		z
			.string()
			.trim()
			.min(1, "An event type cannot be empty")
			.max(100, "An event type is at most 100 characters")
			.regex(
				/^[A-Za-z0-9_.:-]+$/,
				"Write event types as the sender names them, such as issue.created",
			),
	)
	.min(1, "Name at least one event type, or take every event")
	.max(TRIGGER_LIMITS.events, `A trigger can start on up to ${TRIGGER_LIMITS.events} event types`)
	.refine((events) => new Set(events).size === events.length, "An event type is listed twice")
	.nullable();

/** A schedule a trigger can have: one that runs, in a real time zone, and not too often. */
export const triggerSchedule = z
	.object({
		cron: z
			.string()
			.trim()
			.min(1, "Write the schedule as a cron expression, such as 0 9 * * 1-5")
			.max(100, "Keep the cron expression under 100 characters"),
		timeZone: z.string().trim().min(1, "Choose a time zone").max(64),
	})
	.superRefine((schedule, ctx) => {
		const problem = scheduleProblem(schedule);
		if (problem) ctx.addIssue({ code: "custom", path: ["cron"], message: problem });
	});

/** Only webhooks have event types: a schedule's runs all start the same way. */
const ONE_KIND = {
	message: "A scheduled trigger starts on its schedule, not on event types",
	path: ["events"],
};

/** An issue label a trigger starts runs for, as Gateweave Track names it. */
export const triggerLabel = z
	.string()
	.trim()
	.min(1, "A label is at least one character")
	.max(100, "A label is at most 100 characters")
	.nullable();

/** Only webhooks have labels, as they have event types: a schedule's runs all start alike. */
const NO_LABEL = {
	message: "A scheduled trigger starts on its schedule, not on labels",
	path: ["label"],
};

/**
 * The Gateweave Track member a trigger starts runs for, by the id Track gives them: what MCP's
 * `get_workspace` returns as `you` for an agent's key.
 */
export const triggerAssignee = z
	.string()
	.trim()
	.min(1, "Give the member's id")
	.max(64, "A member's id is at most 64 characters")
	.regex(/^[A-Za-z0-9_-]+$/, "Give the member's id as Track gives it: letters, digits, - and _")
	.nullable();

/** Only webhooks name an assignee: a schedule's runs are about no issue. */
const NO_ASSIGNEE = {
	message: "A scheduled trigger starts on its schedule, not on assignees",
	path: ["assignee"],
};

/** A schedule's runs are about no issue either, so each has a conversation of its own. */
const NOT_PER_ISSUE = {
	message: "A scheduled trigger's runs are about no issue, so each has its own conversation",
	path: ["perIssue"],
};

export const triggerInput = z
	.object({
		name,
		prompt,
		target: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("agent"), agentId: id }),
			z.object({ kind: z.literal("team"), teamId: id }),
		]),
		perDay: perDay.default(TRIGGER_LIMITS.defaultPerDay),
		events: triggerEvents.default(null),
		label: triggerLabel.default(null),
		assignee: triggerAssignee.default(null),
		perIssue: z.boolean().default(false),
		schedule: triggerSchedule.nullable().default(null),
	})
	.refine((input) => input.schedule === null || input.events === null, ONE_KIND)
	.refine((input) => input.schedule === null || input.label === null, NO_LABEL)
	.refine((input) => input.schedule === null || input.assignee === null, NO_ASSIGNEE)
	.refine((input) => input.schedule === null || !input.perIssue, NOT_PER_ISSUE);
export type TriggerInput = z.input<typeof triggerInput>;

/**
 * A trigger keeps its target: another agent or team gets a trigger of its own. A schedule given
 * or taken away makes it a scheduled trigger or a webhook's.
 */
export const triggerPatch = z
	.object({
		name: name.optional(),
		prompt: prompt.optional(),
		perDay: perDay.optional(),
		events: triggerEvents.optional(),
		label: triggerLabel.optional(),
		assignee: triggerAssignee.optional(),
		perIssue: z.boolean().optional(),
		schedule: triggerSchedule.nullable().optional(),
		active: z.boolean().optional(),
	})
	.refine((patch) => !patch.schedule || !patch.events, ONE_KIND)
	.refine((patch) => !patch.schedule || !patch.label, NO_LABEL)
	.refine((patch) => !patch.schedule || !patch.assignee, NO_ASSIGNEE)
	.refine((patch) => !patch.schedule || !patch.perIssue, NOT_PER_ISSUE);
export type TriggerPatch = z.input<typeof triggerPatch>;

/**
 * A secret the sender made, pasted in place of the trigger's own: Gateweave Track, for one, shows
 * its webhook's secret once and signs with that.
 */
export const triggerSecret = z
	.string()
	.trim()
	.regex(
		/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/,
		"Paste the whole secret, starting with whsec_, as the sender shows it",
	);

/**
 * The message a delivery starts its run with: the prompt, with each `{{path}}` replaced by what
 * the event holds there (`{{data.issue.title}}`), and the event itself after it, as it came.
 */
export function triggerMessage(promptText: string, body: string): string {
	let event: unknown;
	try {
		event = JSON.parse(body);
	} catch {
		event = undefined;
	}
	const filled = promptText.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) =>
		textAt(event, path),
	);
	const fence = event === undefined ? "text" : "json";
	return `${filled}\n\nThe event, as it was sent:\n\n\`\`\`${fence}\n${body}\n\`\`\``;
}

/**
 * The first time after `after` that the schedule starts a run, in milliseconds; null if it never
 * does again.
 */
export function nextScheduledRun(schedule: TriggerSchedule, after: number): number | null {
	return cronOf(schedule).nextRun(new Date(after))?.getTime() ?? null;
}

/** Why a trigger cannot have this schedule, in words a person reads; null when it can. */
export function scheduleProblem(schedule: TriggerSchedule, now = Date.now()): string | null {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone });
	} catch {
		return `${schedule.timeZone} is not a time zone. Name one as Europe/Istanbul or UTC are named`;
	}
	let runs: Date[];
	try {
		runs = cronOf(schedule).nextRuns(13, new Date(now));
	} catch (error) {
		const reason = error instanceof Error ? error.message.replace(/^CronPattern: /, "") : "";
		return `Write the schedule as a cron expression of five fields, such as 0 9 * * 1-5 (${reason})`;
	}
	if (runs.length === 0) return "This schedule never runs";
	const shortest = TRIGGER_LIMITS.scheduleMinutes * 60_000;
	for (let index = 1; index < runs.length; index++) {
		const gap = (runs[index]?.getTime() ?? 0) - (runs[index - 1]?.getTime() ?? 0);
		if (gap < shortest) {
			return `A schedule can run at most every ${TRIGGER_LIMITS.scheduleMinutes} minutes`;
		}
	}
	return null;
}

/**
 * Why an event does not start a run of a trigger that takes only issues with `label`, in words a
 * person reads; null when it does. Labels are compared trimmed and ignoring case. On `issue.updated`
 * the label must have just been added: `updatedFrom.labelIds` lists the labels before the change,
 * so an edit of a labeled issue that kept the label starts nothing. The body is whatever the
 * sender sent, so every field is checked before it is used.
 */
export function labelSkip(label: string, body: string): string | null {
	const wanted = label.trim().toLowerCase();
	const event = recordOf(parseJson(body));
	const issue = recordOf(recordOf(event?.data)?.issue);
	if (!issue) {
		return `It starts runs only on issues labeled ${label}, and the event is not about an issue`;
	}
	const matching = (Array.isArray(issue.labels) ? issue.labels : []).flatMap((entry) => {
		const found = recordOf(entry);
		if (typeof found?.id !== "string" || typeof found.name !== "string") return [];
		return found.name.trim().toLowerCase() === wanted ? [found.id] : [];
	});
	if (matching.length === 0) return `It starts runs only on issues labeled ${label}`;
	if (event?.type === "issue.updated") {
		const before = recordOf(recordOf(event.data)?.updatedFrom)?.labelIds;
		// Added when some label of that name was not on the issue before the change.
		const added = Array.isArray(before) && matching.some((id) => !before.includes(id));
		if (!added) return `The label ${label} was on the issue already`;
	}
	return null;
}

/**
 * Why an event does not start a run of a trigger that takes only issues assigned to `assignee`, in
 * words a person reads; null when it does. The issue must be assigned to them, and on
 * `issue.updated` they must have just been assigned: `updatedFrom` holds the fields the change
 * touched, so an edit of an issue that stayed theirs starts nothing. A comment starts a run while
 * the issue is theirs, but only a person's: Track does not send the member's own, and one by
 * another agent or by Track itself starts nothing, so two agents cannot keep each other going.
 * Other events start a run while the issue is theirs. The body is whatever the sender sent, so
 * every field is checked before it is used.
 */
export function assigneeSkip(assignee: string, body: string): string | null {
	const event = recordOf(parseJson(body));
	const data = recordOf(event?.data);
	const issue = recordOf(data?.issue);
	if (!issue) {
		return "It starts runs only on issues assigned to its member, and the event is not about an issue";
	}
	if (issue.assigneeId !== assignee) return "The issue is not assigned to its member";
	if (event?.type === "issue.updated") {
		const before = recordOf(data?.updatedFrom);
		if (!before || !Object.hasOwn(before, "assigneeId")) {
			return "The issue was assigned to its member already";
		}
	}
	if (typeof event?.type === "string" && event.type.startsWith("comment.")) {
		if (recordOf(data?.actor)?.type !== "person") {
			return "Only a person's comment starts a run, not an agent's or Track's";
		}
	}
	return null;
}

/** The longest workspace or issue id `issueOfEvent` takes; Track's are far shorter. */
const MAX_ISSUE_ID = 64;

/**
 * The Gateweave Track issue an event is about, for a per-issue trigger: `subject` names it across
 * workspaces as `<workspace id>:<issue id>`, which stay the same when the issue is renamed or
 * moved to another team, and `key` is what people call it, such as `ENG-42`, when the event says.
 * Null when the event is about no issue. The body is whatever the sender sent, so every field is
 * checked before it is used.
 */
export function issueOfEvent(body: string): { subject: string; key: string | null } | null {
	const data = recordOf(recordOf(parseJson(body))?.data);
	const issue = recordOf(data?.issue);
	const workspace = recordOf(data?.workspace)?.id;
	const id = issue?.id;
	const fits = (value: unknown): value is string =>
		typeof value === "string" && value.length > 0 && value.length <= MAX_ISSUE_ID;
	if (!fits(id) || !fits(workspace)) return null;
	const key = typeof issue?.key === "string" ? issue.key.trim().slice(0, 40) : "";
	return { subject: `${workspace}:${id}`, key: key === "" ? null : key };
}

/**
 * The event a schedule's run starts with, in place of a webhook's body, so a prompt can say
 * `{{data.scheduledFor}}`.
 */
export function scheduleEvent(schedule: TriggerSchedule, at: number): string {
	const time = new Date(at).toISOString();
	return JSON.stringify({
		type: SCHEDULE_EVENT,
		timestamp: time,
		data: { scheduledFor: time, ...schedule },
	});
}

/** Paused, and without a callback, so it only reads the pattern and starts no timer. */
function cronOf({ cron, timeZone }: TriggerSchedule): Cron {
	return new Cron(cron, { timezone: timeZone, mode: "5-part", paused: true });
}

/** The event's `type`, as Standard Webhooks payloads carry it; null when it has none. */
export function eventType(body: string): string | null {
	try {
		const type = (JSON.parse(body) as { type?: unknown } | null)?.type;
		return typeof type === "string" && type.length > 0 ? type.slice(0, 100) : null;
	} catch {
		return null;
	}
}

function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function textAt(value: unknown, path: string): string {
	let at = value;
	for (const key of path.split(".")) {
		if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return "";
		at = (at as Record<string, unknown>)[key];
	}
	if (at === null || at === undefined) return "";
	return typeof at === "object" ? JSON.stringify(at) : String(at);
}
