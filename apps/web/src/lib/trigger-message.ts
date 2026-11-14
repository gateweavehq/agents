import { TRIGGER_MESSAGE_METADATA } from "@gateweave/agents-model";
import type { UIMessage } from "ai";
import { httpUrl } from "./safe-url";

/**
 * What a trigger's delivery put in a conversation, taken apart for the pages: the prompt as the
 * trigger filled it in, the event as the sender sent it, and anything the runtime added after it.
 * The model gets the whole text; only the pages split it.
 */
export interface TriggerMessage {
	prompt: string;
	/** The event's body, exactly as it came. */
	body: string;
	/** What follows the event, such as the note with the run's page. Empty when nothing does. */
	after: string;
}

/** Said by `triggerMessage` in `@gateweave/agents-model`, between the prompt and the event. */
const EVENT_INTRO = "\n\nThe event, as it was sent:\n\n```";

/**
 * Takes a trigger's message apart, or returns null when the text is not in the shape
 * `triggerMessage` makes: the prompt, the introduction, a fence holding the body, and at most a
 * note after it. Conservative on purpose: a person's own message that mentions the phrase stays
 * a message.
 */
export function readTriggerMessage(text: string): TriggerMessage | null {
	// The prompt is filled in from the event, and the event is the sender's, so either can hold
	// the introduction and a fence of its own. Nothing in the text says which one is real, and a
	// card built from the wrong one would show an event that was never sent. So when more than one
	// place reads as the event, none is taken, and the page shows the text as it is.
	let found: TriggerMessage | null = null;
	for (
		let intro = text.indexOf(EVENT_INTRO);
		intro >= 0;
		intro = text.indexOf(EVENT_INTRO, intro + 1)
	) {
		const read = readTriggerMessageAt(text, intro);
		if (!read) continue;
		if (found) return null;
		found = read;
	}
	return found;
}

function readTriggerMessageAt(text: string, intro: number): TriggerMessage | null {
	const afterIntro = text.slice(intro + EVENT_INTRO.length);
	const lineEnd = afterIntro.indexOf("\n");
	if (lineEnd < 0) return null;
	// The info string is `json` for a JSON event and `text` for anything else.
	if (!["json", "text"].includes(afterIntro.slice(0, lineEnd))) return null;
	const inside = afterIntro.slice(lineEnd + 1);
	// The body may hold a fence of its own, so the closing one is the last. The note after it has none.
	const close = inside.lastIndexOf("\n```");
	if (close < 0) return null;
	const after = inside.slice(close + "\n```".length);
	if (after !== "" && !after.startsWith("\n\n")) return null;
	return { prompt: text.slice(0, intro), body: inside.slice(0, close), after: after.trim() };
}

/** Whether the message is stored with the marker a delivery's message gets. */
export function isMarkedTriggerMessage(message: Pick<UIMessage, "metadata">): boolean {
	const { metadata } = message;
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		"source" in metadata &&
		metadata.source === TRIGGER_MESSAGE_METADATA.source
	);
}

/** The event pretty-printed with two spaces; text that is not JSON is shown as it came. */
export function prettyEvent(body: string): string {
	try {
		return JSON.stringify(JSON.parse(body), null, 2) ?? body;
	} catch {
		return body;
	}
}

export interface EventView {
	/** `track`, `schedule`, or `other` for a sender the page does not know. */
	source: "track" | "schedule" | "other";
	/** "Track: issue created", or for others the sender's own type. */
	title: string;
	type: string | null;
	issue: { key: string | null; title: string | null; url: string | null } | null;
	actor: string | null;
	/** Milliseconds since the epoch, when the event says. */
	at: number | null;
}

const TRACK_WORDS: Record<string, string> = {
	"issue.created": "issue created",
	"issue.updated": "issue changed",
	"issue.deleted": "issue deleted",
	"comment.created": "comment added",
	"comment.updated": "comment changed",
	"comment.deleted": "comment deleted",
};

const TRACK_TYPE = /^(issue|comment|proposal|relation|project_update)\.[a-z_]+$/;

/** Words for an event type the page has none for: `proposal.accepted` is "proposal accepted". */
function plainType(type: string): string {
	return type.replace(/[._]+/g, " ").trim();
}

/**
 * Reads the event of a trigger's message for the card. The body is whatever the sender sent, so
 * every field is checked, and nothing here throws.
 */
export function describeEvent(body: string, triggerName: string | null = null): EventView {
	const event = record(parse(body));
	const type = typeof event?.type === "string" && event.type ? event.type.slice(0, 100) : null;
	const data = record(event?.data);

	if (type === "schedule") {
		return {
			source: "schedule",
			title: triggerName ? `Schedule: ${triggerName}` : "Schedule",
			type,
			issue: null,
			actor: null,
			at: timeOf(data?.scheduledFor) ?? timeOf(event?.timestamp),
		};
	}

	if (type !== null && TRACK_TYPE.test(type) && data && record(data.workspace)) {
		const issue = record(data.issue);
		return {
			source: "track",
			title: `Track: ${TRACK_WORDS[type] ?? plainType(type)}`,
			type,
			issue: issue
				? {
						key: text(issue.key, 40),
						title: text(issue.title, 300),
						url: typeof issue.url === "string" ? httpUrl(issue.url) : null,
					}
				: null,
			actor: text(record(data.actor)?.name, 100),
			at: timeOf(event?.timestamp),
		};
	}

	return {
		source: "other",
		title: triggerName ?? "Trigger",
		type,
		issue: null,
		actor: null,
		at: timeOf(event?.timestamp),
	};
}

function parse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed.slice(0, max);
}

/** The latest time a `Date` can hold, in milliseconds. */
const MAX_DATE_MS = 8.64e15;

/** An ISO time, or a number of milliseconds or of seconds; null for anything else. */
function timeOf(value: unknown): number | null {
	let ms: number;
	if (typeof value === "number" && Number.isFinite(value)) ms = value < 1e11 ? value * 1000 : value;
	else if (typeof value === "string") ms = Date.parse(value);
	else return null;
	// A sender can put any number here, and one past what a Date holds would throw when shown.
	return Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS ? ms : null;
}
