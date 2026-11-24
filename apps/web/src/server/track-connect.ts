/**
 * Connecting Gateweave Track in one step (AGT-119), the Worker's half. Track's half is its
 * `/connect/agent` page and `/api/connect/*` routes.
 *
 * 1. An owner or admin presses "Connect Track". `beginConnect` checks what it can before they
 *    leave, keeps the pending connection in the registry (`trackConnectBegin`: a state bound to
 *    them, good for ten minutes, taken once, with the verifier that never leaves the server) and
 *    answers with Track's approval page, which names this deployment's webhook URL and return
 *    URL, both on this origin.
 * 2. In Track they choose a workspace and team and allow. Track sends the browser to
 *    /api/track/connected with a one-time code and the state.
 * 3. `finishConnect` takes the state (same person, still an admin of the workspace), trades the
 *    code and the verifier for the agent's key and the webhook's secret server to server, checks
 *    the key with Track, and makes everything in one registry write. If anything fails after the
 *    trade, it asks Track to undo what it made.
 *
 * The key, the secret and the undo token live in this request's memory and the registry's sealed
 * columns. They are never in a page, an address, a log line, an error message or the audit log.
 */
import {
	TRACK_CONNECT_NAMES,
	TRACK_TRIAGE_NAMES,
	TRACK_TRIAGE_TOOLS,
	TRACK_WORK_NAMES,
	TRACK_WORK_TOOLS,
	type TrackConnectChoices,
	type TrackConnectInput,
	type TrackExchangeAnswer,
	trackMcpUrl,
	trackSourceOrigin,
} from "@gateweave/agents-model";
import { checkMcpServer, checkTrackAgent } from "@gateweave/agents-runtime";
import { isAdmin } from "#/lib/roles";
import { trackConnectAddress, trackSourceAddress } from "#/lib/track-connect-address";
import { hostOf } from "../lib/audit-events";
import { auditFor } from "./audit";
import { db, getAuth } from "./auth";
import { demoEnabled } from "./demo/mode";
import { registryFor } from "./registry";
import { exchangeCode, exchangeSourceCode, undoConnection } from "./track-exchange";
import { findMembershipById } from "./workspaces";

/** How the connection ended, shown on the Agents page when nothing was made. */
export type ConnectNotice = "denied" | "failed" | "unreadable" | "expired" | "busy" | "unreachable";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const CODE = /^[A-Za-z0-9_-]{16,200}$/;

/** The address to send the browser to, once what is chosen has been kept. */
export async function beginConnect(
	member: {
		user: { id: string };
		membership: { workspaceId: string; jurisdiction: string | null };
	},
	registry: ReturnType<typeof registryFor>,
	choices: TrackConnectChoices,
	origin: string,
): Promise<string> {
	const begun = await registry.trackConnectBegin(choices as TrackConnectInput, member.user.id);
	if ("status" in begun) throw new Error(begun.message);
	const { workspaceId } = member.membership;
	return trackConnectAddress({
		trackUrl: choices.trackUrl,
		purpose: choices.purpose,
		name: TRACK_CONNECT_NAMES[choices.purpose],
		origin,
		workspaceId,
		triggerId: begun.triggerId,
		state: begun.state,
		verifier: begun.verifier,
	});
}

export async function beginSourceConnect(
	registry: ReturnType<typeof registryFor>,
	userId: string,
	workspaceId: string,
	trackUrl: string,
	origin: string,
): Promise<string> {
	if (!origin.startsWith("https://") || !trackSourceOrigin.safeParse(origin).success) {
		throw new Error("Connecting a Track source requires a public HTTPS address for Agents.");
	}
	if (origin === trackUrl) throw new Error("Track and Agents must have different origins.");
	const pending = await registry.trackConnectBegin({ purpose: "source", trackUrl }, userId);
	if ("status" in pending) throw new Error(pending.message);
	return trackSourceAddress({
		trackUrl,
		origin,
		workspaceId,
		state: pending.state,
		verifier: pending.verifier,
	});
}

export async function finishConnect(
	request: Request,
	flow: "agent" | "source" = "agent",
): Promise<Response> {
	try {
		return await handleConnectCallback(request, flow);
	} catch {
		return page(
			500,
			"Track approval could not be completed",
			"Open the Agents page to check the connection before trying again.",
		);
	}
}

async function handleConnectCallback(
	request: Request,
	flow: "agent" | "source",
): Promise<Response> {
	// Reaching out with a visitor's address is off in the demo, as the manual setup is.
	if (demoEnabled()) return page(404, "Not found", "This page does not exist.");
	const url = new URL(request.url);
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) {
		return flow === "agent"
			? redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`)
			: redirect("/login?redirect=%2F");
	}
	// The return address named the workspace; the state is the pending connection's alone.
	const workspaceId = url.searchParams.get("workspace") ?? "";
	const token = url.searchParams.get("state") ?? "";
	if (!ID.test(workspaceId) || !TOKEN.test(token)) {
		return page(400, "Not connected", "This is not a connection this server started.");
	}
	const membership = await findMembershipById(db, workspaceId, session.user.id);
	if (!membership) return page(404, "Not found", "This page does not exist.");
	if (!isAdmin(membership.role)) {
		return page(403, "Not connected", "Only an owner or an admin of the workspace can do this.");
	}
	const registry = registryFor(membership);
	// Used up whatever comes next, so what Track sent cannot be replayed.
	const pending = await registry.trackConnectTake(token, session.user.id);
	if (!pending) {
		return page(
			400,
			"Not connected",
			"This connection was not started by you, was used already, or took longer than ten minutes. Start it again from the Agents page.",
			agentsPath(membership.slug),
		);
	}
	const { slug } = membership;
	if ((pending.choices.purpose === "source") !== (flow === "source")) {
		return page(400, "Not connected", "This approval belongs to another Track connection.");
	}
	if (pending.choices.purpose === "source") {
		return finishSourceConnect(
			url,
			{ slug, workspaceId, userId: session.user.id },
			pending.choices.trackUrl,
			pending.triggerId,
			pending.verifier,
		);
	}

	const code = url.searchParams.get("code");
	if (url.searchParams.get("error") || !code) {
		return redirect(
			`${agentsPath(slug)}?trackConnect=${url.searchParams.get("error") === "denied" ? "denied" : "failed"}`,
		);
	}
	if (!CODE.test(code)) return redirect(`${agentsPath(slug)}?trackConnect=failed`);

	const trackOrigin = pending.choices.trackUrl;
	const exchanged = await exchangeCode(trackOrigin, code, pending.verifier);
	if (!exchanged.ok) {
		// Track made the agent member and the webhook when the person allowed. An answer that could
		// not be used but names its undo token has them taken back; without one the notice says what
		// may be left in Track, since nothing here can remove it.
		if (exchanged.undo && !(await undoConnection(trackOrigin, exchanged.undo))) {
			return leftBehind(slug, trackOrigin, null);
		}
		const notice: ConnectNotice =
			exchanged.why === "refused"
				? "expired"
				: exchanged.why === "unexpected"
					? // Undone by its token, nothing is left; without one, something may be.
						exchanged.undo
						? "failed"
						: "unreadable"
					: exchanged.why === "busy"
						? "busy"
						: "unreachable";
		return redirect(`${agentsPath(slug)}?trackConnect=${notice}`);
	}

	const { answer } = exchanged;
	let made: Awaited<ReturnType<typeof setUp>>;
	try {
		made = await setUp(registry, session.user, pending.choices, pending.triggerId, answer);
	} catch (error) {
		// What was thrown can name a field but never holds the key; still only its kind is kept.
		console.error("track-connect: the setup after the exchange failed", {
			error: error instanceof Error ? error.name : "unknown",
		});
		made = { problem: "Gateweave Agents could not save the agent." };
	}
	if ("problem" in made) {
		const undone = await undoConnection(trackOrigin, answer.undo);
		return undone
			? page(
					500,
					"Not connected",
					`${made.problem} Nothing was left behind in Track or here.`,
					agentsPath(slug),
				)
			: leftBehind(slug, trackOrigin, answer, made.problem);
	}

	const audit = auditFor({ user: session.user, membership: { workspaceId } });
	const target = { type: "agent", id: made.agentId, label: made.agentName } as const;
	await audit({
		action: pending.choices.purpose === "work" ? "trackWork.setUp" : "trackTriage.setUp",
		target,
		detail: { track: hostOf(trackOrigin) },
	});
	await audit({
		action: "track.connected",
		target,
		detail: { origin: trackOrigin, workspace: answer.workspace.slug, trackAgent: answer.agent.id },
	});
	const notice = new URLSearchParams({
		trackConnected: pending.choices.purpose,
		workspaceName: answer.workspace.name,
		workspaceSlug: answer.workspace.slug,
		agentName: answer.agent.name,
	});
	return redirect(`${agentsPath(slug)}/${encodeURIComponent(made.agentId)}?${notice.toString()}`);
}

async function finishSourceConnect(
	url: URL,
	starter: { slug: string; workspaceId: string; userId: string },
	trackOrigin: string,
	connectionId: string,
	verifier: string,
): Promise<Response> {
	const back = agentsPath(starter.slug);
	const notice = (status: "connected" | "denied" | "failed" | "duplicate") =>
		redirect(`${back}?trackSource=${status}`);
	const code = url.searchParams.get("code");
	const error = url.searchParams.get("error");
	if (error === "denied") return notice("denied");
	if (error || !code || !CODE.test(code)) {
		return sourceLeftBehind(back, "Track did not return a usable approval code.");
	}

	const exchanged = await exchangeSourceCode(trackOrigin, code, verifier);
	if (!exchanged.ok) {
		if (exchanged.undo && (await undoConnection(trackOrigin, exchanged.undo))) {
			return notice("failed");
		}
		const message = {
			refused: "Track did not accept the approval code.",
			busy: "Track asked Agents to wait before trying again.",
			unreachable: "Agents could not reach Track.",
			unexpected: "Track returned an unusable answer.",
		}[exchanged.why];
		return sourceLeftBehind(back, message);
	}

	const { sourceKey, source, workspace, team, undo } = exchanged.answer;
	// Track supplies the labels and IDs. An untrusted reply must not copy a secret into them.
	const labels = [source.id, ...Object.values(workspace), ...Object.values(team)];
	if (
		labels.some(
			(label) =>
				[sourceKey, code, verifier].some((secret) => label.includes(secret)) ||
				label === undo ||
				(undo.length >= 16 && label.includes(undo)),
		)
	) {
		return (await undoConnection(trackOrigin, undo))
			? notice("failed")
			: sourceLeftBehind(back, "Track returned an unusable answer.");
	}

	// The exchange is a network call. Check whether the starter still has permission to save.
	const membership = await findMembershipById(db, starter.workspaceId, starter.userId).catch(
		() => undefined,
	);
	if (!membership || !isAdmin(membership.role)) {
		const unavailable = membership === undefined;
		const reason = unavailable
			? "Agents could not confirm your workspace permissions."
			: "Only a current workspace owner or admin can save a reporting destination.";
		return (await undoConnection(trackOrigin, undo))
			? page(unavailable ? 503 : 403, "Not connected", reason, back)
			: sourceLeftBehind(back, reason);
	}
	const registry = registryFor(membership);

	let saved: Awaited<ReturnType<typeof registry.saveTrackSource>>;
	try {
		saved = await registry.saveTrackSource(connectionId, {
			trackOrigin,
			sourceKey,
			source,
			workspace,
			team,
		});
	} catch {
		const present = await registry
			.hasTrackSource({
				trackOrigin,
				workspaceId: workspace.id,
				teamId: team.id,
				sourceId: source.id,
			})
			.catch(() => false);
		if (present) return notice("connected");
		// An absent row can also mean an interrupted save has yet to settle.
		return page(
			503,
			"Connection status unknown",
			"Agents could not confirm whether this destination was saved. Check Track run reporting on the Agents page before trying again. You can manage the source under Settings > Sources in Track.",
			back,
		);
	}
	if (saved === "saved") return notice("connected");
	if (await undoConnection(trackOrigin, undo)) {
		return notice(saved === "duplicate" ? "duplicate" : "failed");
	}
	return sourceLeftBehind(
		back,
		saved === "duplicate"
			? "This Track workspace and team are already connected."
			: "Agents could not save this reporting destination.",
	);
}

function sourceLeftBehind(back: string, reason: string): Response {
	return page(
		502,
		"Track source could not be connected",
		`${reason} A source from this approval may still exist in Track. Review it under Settings > Sources in Track before trying again.`,
		back,
	);
}

/**
 * Checks the key with Track and makes everything in one registry write, with the trigger's id the
 * webhook's URL named and the secret Track made. A problem is said in words for the person.
 */
async function setUp(
	registry: ReturnType<typeof registryFor>,
	user: { id: string; name: string | null; email: string },
	choices: TrackConnectChoices,
	triggerId: string,
	answer: TrackExchangeAnswer,
): Promise<{ agentId: string; agentName: string } | { problem: string }> {
	const server = {
		name: choices.purpose === "work" ? TRACK_WORK_NAMES.mcpServer : TRACK_TRIAGE_NAMES.mcpServer,
		transport: "http" as const,
		url: trackMcpUrl(choices.trackUrl),
		headers: { Authorization: `Bearer ${answer.agentKey}` },
		tools: null,
	};
	const by = user.name || user.email;
	const connected = { triggerId, webhookSecret: answer.webhookSecret };
	const { default: instructions } =
		choices.purpose === "work"
			? await import("./track-work.md?raw")
			: await import("./track-triage.md?raw");
	if (choices.purpose === "work") {
		const { check, identity } = await checkTrackAgent(server);
		if (!check.ok) return { problem: "Track did not accept the new agent's key." };
		const offered = new Set(check.tools.map((tool) => tool.name));
		if (TRACK_WORK_TOOLS.some((tool) => !offered.has(tool))) {
			return { problem: "This Track does not offer the tools the agent needs." };
		}
		if ("problem" in identity) return { problem: identity.problem };
		// The trigger matches an issue's assignee against this id, and Track's delivery carries the
		// user id: the one the answer names. A Track that says otherwise would never start a run.
		if (identity.memberId !== answer.agent.id || identity.workspace !== answer.workspace.slug) {
			return { problem: "Track named the new agent in two different ways." };
		}
		const made = await registry.setUpTrackWork(
			{
				trackUrl: choices.trackUrl,
				agentKey: answer.agentKey,
				name: answer.agent.name,
				provider: choices.provider,
				model: choices.model,
				engine: choices.engine,
				repositoryId: choices.repositoryId,
				instructions,
				memberId: identity.memberId,
				memberName: identity.name,
			},
			user.id,
			by,
			connected,
		);
		if ("status" in made) return { problem: made.message };
		await registry.recordMcpCheck(made.mcpServerId, check).catch(() => null);
		return { agentId: made.agent.id, agentName: made.agent.name };
	}
	const check = await checkMcpServer(server);
	if (!check.ok) return { problem: "Track did not accept the new agent's key." };
	const offered = new Set(check.tools.map((tool) => tool.name));
	if (TRACK_TRIAGE_TOOLS.some((tool) => !offered.has(tool))) {
		return { problem: "This Track does not offer the tools triage needs." };
	}
	const made = await registry.setUpTrackTriage(
		{
			trackUrl: choices.trackUrl,
			agentKey: answer.agentKey,
			name: answer.agent.name,
			provider: choices.provider,
			model: choices.model,
			instructions,
		},
		user.id,
		by,
		connected,
	);
	if ("status" in made) return { problem: made.message };
	await registry.recordMcpCheck(made.mcpServerId, check).catch(() => null);
	return { agentId: made.agent.id, agentName: made.agent.name };
}

/** The page for an undo that did not go through: says exactly what is left in Track, and where. */
function leftBehind(
	slug: string,
	trackOrigin: string,
	answer: TrackExchangeAnswer | null,
	problem = "",
): Response {
	const where = hostOf(trackOrigin) ?? trackOrigin;
	const names = answer
		? `the agent member ${answer.agent.name} and its webhook, in the workspace ${answer.workspace.name} (${answer.workspace.slug})`
		: "an agent member and its webhook";
	return page(
		500,
		"Not connected",
		`${problem} Gateweave Agents could not ask Track to take back what it made, so ${names} may still be there on ${where}. In Track, remove the agent member under Settings, Agents, and the webhook under Settings, Webhooks. Nothing was kept here.`.trim(),
		agentsPath(slug),
	);
}

function agentsPath(slug: string) {
	return `/${encodeURIComponent(slug)}/agents`;
}

function redirect(location: string) {
	return new Response(null, {
		status: 302,
		headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
	});
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** A plain page that makes no outbound call. Everything in it is escaped: some is Track's text. */
function page(status: number, title: string, message: string, back?: string): Response {
	const esc = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
	const link = back ? `<p><a href="${esc(back)}">Back to Agents</a></p>` : "";
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(message)}</p>${link}</body></html>`,
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		},
	);
}
