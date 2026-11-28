import {
	type RunFinish,
	TRACK_KEY_VARIABLE,
	TRACK_WORK_EVENTS,
	trackSourceOrigin,
} from "@gateweave/agents-model";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agents, trackSourceDestinations } from "./db/schema";
import { pinnedEnvironment, secretSends } from "./environment";
import type { Db } from "./state";
import { sourceAtTeam } from "./track-sources";

export interface TrackRunTarget {
	destinationId: string;
	sourceId: string;
	origin: string;
	workspaceId: string;
	teamId: string;
	issue: string;
	issueId: string;
	agent: string;
	runsPage: string | null;
}

export interface TrackReservation {
	target: TrackRunTarget;
	key: string;
	queuedAt: number;
	refused: boolean;
}

export interface TrackRunAssociation {
	target: TrackRunTarget;
	runningAt: number;
}

const trackEvent = z.object({
	type: z.enum(TRACK_WORK_EVENTS),
	data: z.object({
		workspace: z.object({
			id: z.string().min(1).max(64),
			slug: z
				.string()
				.min(1)
				.max(100)
				.refine((slug) => slug.isWellFormed()),
		}),
		issue: z.object({
			id: z.string().min(1).max(64),
			key: z
				.string()
				.max(64)
				.regex(/^[A-Z0-9]+-[1-9]\d*$/),
			teamId: z.string().min(1).max(64),
			url: z.url(),
		}),
	}),
});

/** Called only after the signature and the trigger's filters have held. */
export function trackRunTarget(
	db: Db,
	trigger: {
		agentId: string | null;
		teamId: string | null;
		perIssue: boolean;
		assignee: string | null;
		events: string[] | null;
		schedule: unknown;
	},
	body: string,
	runsPage: string | null,
): TrackRunTarget | null {
	if (
		!trigger.agentId ||
		trigger.teamId !== null ||
		!trigger.perIssue ||
		!trigger.assignee ||
		!trigger.events ||
		trigger.schedule !== null
	)
		return null;

	let parsed: ReturnType<typeof trackEvent.safeParse>;
	try {
		parsed = trackEvent.safeParse(JSON.parse(body));
	} catch {
		return null;
	}
	if (!parsed.success || !trigger.events.includes(parsed.data.type)) return null;
	const { workspace, issue } = parsed.data.data;
	const pinned = pinnedEnvironment(db, trigger.agentId);
	if (
		!pinned?.assetId ||
		!pinned.secrets.some(({ name, sealed }) => name === TRACK_KEY_VARIABLE && sealed)
	) {
		return null;
	}
	const origin = secretSends(db, pinned.assetId).get(TRACK_KEY_VARIABLE)?.sentTo;
	if (!origin?.startsWith("https://") || trackSourceOrigin.safeParse(origin).data !== origin) {
		return null;
	}
	const path = `/${encodeURIComponent(workspace.slug)}/issue/${encodeURIComponent(issue.key)}`;
	if (issue.url !== `${origin}${path}`) return null;

	const destination = sourceAtTeam(db, {
		trackOrigin: origin,
		workspaceId: workspace.id,
		teamId: issue.teamId,
	});
	// Track resolves issue keys across a workspace, so match the approved team's prefix as well.
	if (!destination || issue.key.slice(0, issue.key.indexOf("-")) !== destination.teamKey) {
		return null;
	}
	const agent = db
		.select({ name: agents.name })
		.from(agents)
		.where(eq(agents.id, trigger.agentId))
		.get();
	if (!agent) return null;

	return {
		destinationId: destination.id,
		sourceId: destination.sourceId,
		origin,
		workspaceId: workspace.id,
		teamId: issue.teamId,
		issue: issue.key,
		issueId: issue.id,
		agent: agent.name.slice(0, 64).toWellFormed(),
		runsPage: safeRunsPage(runsPage),
	};
}

function safeRunsPage(page: string | null): string | null {
	const url = page && URL.parse(page);
	return url &&
		url.protocol === "https:" &&
		!url.username &&
		!url.password &&
		url.href === `${url.origin}${url.pathname}` &&
		/^\/[^/]+\/runs\/$/.test(url.pathname)
		? url.href
		: null;
}

export function sameTrackIssue(a: TrackRunTarget, b: TrackRunTarget): boolean {
	return (
		a.destinationId === b.destinationId &&
		a.sourceId === b.sourceId &&
		a.origin === b.origin &&
		a.workspaceId === b.workspaceId &&
		a.teamId === b.teamId &&
		a.issue === b.issue &&
		a.issueId === b.issueId
	);
}

export function reportDestination(db: Db, target: TrackRunTarget) {
	return db
		.select({ sealedKey: trackSourceDestinations.sealedKey })
		.from(trackSourceDestinations)
		.where(
			and(
				eq(trackSourceDestinations.id, target.destinationId),
				eq(trackSourceDestinations.sourceId, target.sourceId),
				eq(trackSourceDestinations.trackOrigin, target.origin),
				eq(trackSourceDestinations.workspaceId, target.workspaceId),
				eq(trackSourceDestinations.teamId, target.teamId),
			),
		)
		.get();
}

export type TrackRefusal =
	| "budget-limit"
	| "waiting-for-slot"
	| "needs-mapping"
	| "provider"
	| "sandbox-policy"
	| "files-policy"
	| "unavailable";

const refusalDetail: Record<TrackRefusal, string> = {
	"budget-limit": "A usage limit was reached. Retry when the limit resets.",
	"waiting-for-slot": "Run capacity is in use. Retry when a slot is free.",
	"needs-mapping": "An admin needs to check the agent's repository setup.",
	provider: "An admin needs to check the agent's model provider setup.",
	"sandbox-policy": "An admin needs to check whether sandboxes are available to this workspace.",
	"files-policy": "An admin needs to check whether repository file runs are enabled.",
	unavailable: "An admin needs to check the trigger and agent setup.",
};

type ReportPhase =
	| { state: "queued" }
	| { state: "running"; startedAt: number }
	| { state: "failed"; refusal: TrackRefusal; detail?: string }
	| { state: "passed" | "failed" | "cancelled"; startedAt: number; endedAt: number };

export interface TrackReport {
	target: TrackRunTarget;
	key: string;
	sentAt: number;
	phase: ReportPhase;
}

export function trackReportBody({ target, key, sentAt, phase }: TrackReport) {
	const run = "startedAt" in phase;
	const refusal = "refusal" in phase ? phase.refusal : null;
	const detail = refusal && "detail" in phase ? phase.detail : undefined;
	const waitReason =
		refusal === "budget-limit" || refusal === "waiting-for-slot" || refusal === "needs-mapping"
			? refusal
			: null;
	return {
		kind: "run",
		key,
		title: "Hosted agent run",
		state: phase.state,
		sentAt: new Date(sentAt).toISOString(),
		issue: target.issue,
		executor: "agents-hosted",
		agent: target.agent,
		...(run && { startedAt: new Date(phase.startedAt).toISOString() }),
		...(run && target.runsPage && { url: `${target.runsPage}${key}` }),
		...("endedAt" in phase && { endedAt: new Date(phase.endedAt).toISOString() }),
		...(waitReason && { waitReason }),
		...(refusal && {
			progress: "Run could not start",
			waitDetail: detail ?? refusalDetail[refusal],
		}),
		...(run && phase.state === "failed" && { progress: "Run did not complete successfully" }),
	};
}

export function trackFinishReport(
	key: string,
	association: TrackRunAssociation,
	startedAt: number,
	finish: Required<RunFinish>,
	now: number,
): TrackReport {
	const state =
		finish.status === "succeeded" ? "passed" : finish.status === "stopped" ? "cancelled" : "failed";
	return {
		key,
		target: association.target,
		sentAt: Math.max(now, association.runningAt + 1),
		phase: { state, startedAt, endedAt: finish.endedAt },
	};
}
