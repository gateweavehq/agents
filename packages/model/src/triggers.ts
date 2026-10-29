/**
 * Triggers: inbound webhooks that start a run of an agent run by Gateweave, or of a team, with no
 * person in the conversation. Each has its own URL and secret, and checks Standard Webhooks
 * signatures (https://www.standardwebhooks.com), which is what Gateweave Track sends.
 */
import { z } from "zod";

/** How a delivery to a trigger went. */
export const TRIGGER_DELIVERY_STATUSES = [
	/** Taken, with its run about to begin. */
	"accepted",
	/** It started a run. */
	"started",
	/** The trigger was paused, so it started nothing, and a retry starts nothing either. */
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
	/** Largest body a trigger takes, in bytes. */
	bodyBytes: 64 * 1024,
	/** How far a delivery's timestamp may be from now, in seconds, as Standard Webhooks advises. */
	toleranceSeconds: 5 * 60,
	/** Deliveries each trigger shows. */
	shownDeliveries: 10,
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
	/** Signed and within the limits: the run starts in this new conversation, with this message. */
	| { status: "start"; conversationId: string; text: string }
	/** A retry of a delivery that started a run, or was skipped. */
	| { status: "duplicate"; runId: string | null }
	/** A retry of a delivery whose run is starting now: the sender may ask again in `retryAfter`. */
	| { status: "starting"; retryAfter: number }
	/** The trigger is paused. */
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

export const triggerInput = z.object({
	name,
	prompt,
	target: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("agent"), agentId: id }),
		z.object({ kind: z.literal("team"), teamId: id }),
	]),
	perDay: perDay.default(TRIGGER_LIMITS.defaultPerDay),
});
export type TriggerInput = z.input<typeof triggerInput>;

/** A trigger keeps its target: another agent or team gets a trigger of its own. */
export const triggerPatch = z.object({
	name: name.optional(),
	prompt: prompt.optional(),
	perDay: perDay.optional(),
	active: z.boolean().optional(),
});
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

/** The event's `type`, as Standard Webhooks payloads carry it; null when it has none. */
export function eventType(body: string): string | null {
	try {
		const type = (JSON.parse(body) as { type?: unknown } | null)?.type;
		return typeof type === "string" && type.length > 0 ? type.slice(0, 100) : null;
	} catch {
		return null;
	}
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
