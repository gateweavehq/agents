/**
 * Connecting Gateweave Track in one step (AGT-119): the person chooses what the agent is, the
 * browser goes to Track to approve it, and Track hands the agent member's key and the webhook's
 * secret to this server alone, for a one-time code. This holds what both sides must agree on: the
 * choices made before the browser leaves, and what Track's answer must look like. Pure, with no
 * platform types, so the browser can read it too; the address is built in
 * `apps/web/src/lib/track-connect-address.ts` and the flow is the app's
 * (`apps/web/src/server/track-connect.ts`).
 */
import { z } from "zod";
import { agentDefinitionInput } from "./inputs";
import {
	TRACK_TRIAGE_EVENT,
	TRACK_TRIAGE_NAMES,
	trackAgentKey,
	trackUrlInput,
} from "./track-triage";
import { TRACK_WORK_EVENTS, TRACK_WORK_NAMES } from "./track-work";
import { triggerSecret } from "./triggers";
import { AGENT_ENGINES, MODEL_PROVIDERS } from "./vocabulary";

export const TRACK_CONNECT_PURPOSES = ["work", "triage"] as const;
export type TrackConnectPurpose = (typeof TRACK_CONNECT_PURPOSES)[number];

/** How long the person has to approve in Track, from pressing "Connect Track". */
export const TRACK_CONNECT_LIFETIME_MS = 10 * 60_000;

/** The webhook events Track is asked to send, by what is being connected. */
export const TRACK_CONNECT_EVENTS: Record<TrackConnectPurpose, readonly string[]> = {
	work: TRACK_WORK_EVENTS,
	triage: [TRACK_TRIAGE_EVENT],
};

/** The agent's name, as Track is asked to name its member, before the person edits it. */
export const TRACK_CONNECT_NAMES: Record<TrackConnectPurpose, string> = {
	work: TRACK_WORK_NAMES.agent,
	triage: TRACK_TRIAGE_NAMES.agent,
};

const common = {
	trackUrl: trackUrlInput,
	provider: z.enum(MODEL_PROVIDERS),
	model: agentDefinitionInput.shape.model,
};

/** What the person chooses before leaving for Track. */
export const trackConnectInput = z.discriminatedUnion("purpose", [
	z.object({
		purpose: z.literal("work"),
		...common,
		engine: z.enum(AGENT_ENGINES),
		repositoryId: z.string().min(1, "Choose the repository it works in").max(64),
	}),
	z.object({ purpose: z.literal("triage"), ...common }),
]);
export type TrackConnectInput = z.input<typeof trackConnectInput>;
export type TrackConnectChoices = z.output<typeof trackConnectInput>;

/** A PKCE verifier: 43 to 128 characters of RFC 7636's unreserved set. */
export const trackConnectVerifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/** The most of Track's answer to the exchange that is read; the real one is under a kilobyte. */
export const TRACK_EXCHANGE_MAX_BYTES = 16 * 1024;

const trackId = z.string().min(1).max(64);
const trackWorkspace = z.object({
	id: trackId,
	slug: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
});

/**
 * Track's answer to `POST /api/connect/exchange`, which this server checks before using any of
 * it: the key and the secret in the shapes Track makes, nothing missing, nothing oversized. The
 * `undo` token is opaque here.
 */
export const trackExchangeAnswer = z.object({
	agentKey: trackAgentKey,
	webhookSecret: triggerSecret,
	agent: z.object({
		/** The user id: what MCP, the webhook's "For agent" and an issue's assignee carry. */
		id: trackId,
		/** The member row's id in Track, which nothing here uses. */
		memberId: trackId,
		name: z.string().trim().min(1).max(200),
	}),
	workspace: trackWorkspace,
	webhook: z.object({ id: trackId }),
	undo: z.string().min(1).max(4096),
});
export type TrackExchangeAnswer = z.output<typeof trackExchangeAnswer>;

export const TRACK_SOURCE_NAME = "Gateweave Agents";
export const TRACK_SOURCE_PRODUCT = "agents";

// A pasted page is fine, but reject URL forms that the origin parser might silently repair
// or strip credentials from before checking the hostname.
export const trackSourceOrigin = z
	.string()
	.trim()
	.max(2000)
	.refine((value) => {
		const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1]?.toLowerCase();
		if (!authority || /[@%]/.test(authority) || /[\\\s]/.test(value)) return false;
		try {
			const { host, hostname, port, protocol } = new URL(value);
			const defaultPort = protocol === "https:" ? "443" : "80";
			return (
				!hostname.endsWith(".") &&
				(authority === host || (!port && authority === `${hostname}:${defaultPort}`))
			);
		} catch {
			return false;
		}
	}, "Enter a Track URL with a valid hostname and no credentials")
	.pipe(trackUrlInput);

export const trackPendingInput = z.discriminatedUnion("purpose", [
	trackConnectInput,
	z.object({ purpose: z.literal("source"), trackUrl: trackSourceOrigin }),
]);
export type TrackPendingInput = z.input<typeof trackPendingInput>;
export type TrackPendingChoices = z.output<typeof trackPendingInput>;

export const trackSourceUndo = z.string().min(1).max(512);

const trackSourceIdentity = z.strictObject({
	id: trackId,
	name: z.literal(TRACK_SOURCE_NAME),
	product: z.literal(TRACK_SOURCE_PRODUCT),
});
const trackSourceTeam = z.strictObject({
	id: trackId,
	key: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
});

const trackSourceDetails = z.strictObject({
	sourceKey: z.string().regex(/^gws_[A-Za-z0-9_-]{43}$/),
	source: trackSourceIdentity,
	workspace: trackWorkspace.strict(),
	team: trackSourceTeam,
});

export const trackSourceAnswer = (trackOrigin: string) =>
	trackSourceDetails.extend({
		endpoint: z.literal(new URL("/api/events", trackOrigin).href),
		undo: trackSourceUndo,
		undoUntil: z.iso.datetime(),
	});

export const trackSourceSave = trackSourceDetails.extend({ trackOrigin: trackSourceOrigin });
export type TrackSourceSave = z.input<typeof trackSourceSave>;

export const trackSourceLocator = z.object({
	trackOrigin: trackSourceOrigin,
	workspaceId: trackId,
	teamId: trackId,
	sourceId: trackId,
});
export type TrackSourceLocator = z.input<typeof trackSourceLocator>;

export interface TrackSourceDestination extends TrackSourceLocator {
	id: string;
	workspaceSlug: string;
	workspaceName: string;
	teamKey: string;
	teamName: string;
	sourceName: string;
	sourceProduct: string;
}
