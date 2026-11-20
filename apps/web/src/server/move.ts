import { env } from "cloudflare:workers";
import {
	METER_NAME,
	type MoveSource,
	type MoveTarget,
	moveWorkspace,
	objectsIn,
} from "@gateweave/agents-registry";
import { conversationName, MOVED_IN } from "@gateweave/agents-runtime";
import { and, asc, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { deploymentJurisdiction } from "./jurisdiction";
import type { WorkspaceRef } from "./workspaces";

// "Where a workspace lives" in docs/architecture.md.

/**
 * How many workspaces one daily run moves. Each conversation takes about a dozen calls to the two
 * objects, of the thousand a Worker on the Free plan may make to Cloudflare's services; the Paid
 * plan allows ten thousand. One that holds a repository's files (`file-store.ts` in the runtime,
 * which nothing uses yet) takes a read and a write more for every 4 MB of them: about forty calls
 * at the most it can hold.
 */
const MOVES_PER_RUN = 3;

const MOVED_COPY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const FORGETS_PER_RUN = 3;
// Each conversation can call its sandbox too. Leave room within the Free plan's thousand
// calls for recording progress, the moves and the rest of the daily run.
const CONVERSATION_FORGETS_PER_RUN = 200;
const AT_ONCE = 10;

/**
 * Moves workspaces whose Durable Objects are outside the deployment's jurisdiction into it, the
 * oldest first, a few each run: the registry and every conversation, with what each conversation's
 * sandbox keeps. Each workspace is paused for the seconds its copy takes; one with a turn under way
 * waits for the next run. The deployment's sandbox meter moves first, and old sealed copies are
 * forgotten after a week even if the deployment has since unset its jurisdiction.
 */
export async function moveWorkspaces(db: Database): Promise<void> {
	await forgetMovedCopies(db);
	const target = deploymentJurisdiction();
	if (target) await moveInto(db, target);
}

async function moveInto(db: Database, target: DurableObjectJurisdiction): Promise<void> {
	try {
		await moveMeter(target);
	} catch (error) {
		console.error(`move: the sandbox meter didn't move to ${target}: ${messageOf(error)}`);
	}
	const elsewhere = await db
		.select({
			workspaceId: schema.organization.id,
			jurisdiction: schema.workspaceLocation.jurisdiction,
		})
		.from(schema.organization)
		.leftJoin(
			schema.workspaceLocation,
			eq(schema.workspaceLocation.workspaceId, schema.organization.id),
		)
		.where(
			and(
				// D1 has room for one old place. Forget it before taking the workspace elsewhere.
				isNull(schema.workspaceLocation.movedFrom),
				or(
					isNull(schema.workspaceLocation.jurisdiction),
					ne(schema.workspaceLocation.jurisdiction, target),
				),
			),
		)
		.orderBy(asc(schema.organization.createdAt))
		.limit(MOVES_PER_RUN)
		.all();
	for (const workspace of elsewhere) {
		const started = Date.now();
		try {
			const report = await moveWorkspace(workspaceMove(db, workspace, target));
			if (!report.moved) {
				console.log(
					`move: workspace ${workspace.workspaceId} waits, with ${report.busy} turns or wikis under way`,
				);
				continue;
			}
			const what = report.finished
				? "finishing a move that had committed it"
				: `${report.conversations} conversations and ${report.rows} rows`;
			console.log(
				`move: workspace ${workspace.workspaceId} is in ${target} now, ${what}, in ${Date.now() - started} ms`,
			);
		} catch (error) {
			// The message itself: an error that came over RPC logs only the stack of this side.
			console.error(
				`move: workspace ${workspace.workspaceId} didn't move to ${target}: ${messageOf(error)}`,
			);
		}
	}
}

export async function forgetMovedCopies(
	db: Database,
	budget = CONVERSATION_FORGETS_PER_RUN,
): Promise<void> {
	const location = schema.workspaceLocation;
	const due = await db
		.select()
		.from(location)
		.where(
			and(
				isNotNull(location.movedFrom),
				lte(location.movedAt, Date.now() - MOVED_COPY_DAYS * DAY_MS),
			),
		)
		// A few copies that keep failing must not take every slot on every run.
		.orderBy(sql`random()`)
		.limit(FORGETS_PER_RUN)
		.all();
	for (const { workspaceId, jurisdiction, movedFrom: from, movedAt } of due) {
		if (from === null || movedAt === null) continue;
		if (from === jurisdiction) {
			console.error(`move: workspace ${workspaceId} lists its current place as its old copy`);
			continue;
		}
		try {
			const registry = objectsIn(env.REGISTRY, from).getByName(workspaceId);
			const ids = await registry.moveConversationsToForget();
			const taking = ids.slice(0, budget);
			budget -= taking.length;
			let failed = false;
			const conversations = objectsIn(env.CONVERSATIONS, from);
			for (let start = 0; start < taking.length; start += AT_ONCE) {
				const results = await Promise.all(
					taking.slice(start, start + AT_ONCE).map(async (id) => {
						try {
							const name = conversationName(workspaceId, id);
							await conversations.getByName(name).moveForget();
							return id;
						} catch (error) {
							failed = true;
							console.error(
								`move: workspace ${workspaceId} couldn't forget conversation ${id}: ${messageOf(error)}`,
							);
							return null;
						}
					}),
				);
				const forgotten = results.filter((id) => id !== null);
				if (forgotten.length > 0) await registry.moveNoteForgotten(forgotten);
			}
			if (failed || taking.length < ids.length) continue;
			await registry.moveForget();
			await db
				.update(location)
				.set({ movedFrom: null })
				.where(
					and(
						eq(location.workspaceId, workspaceId),
						eq(location.jurisdiction, jurisdiction),
						eq(location.movedFrom, from),
						eq(location.movedAt, movedAt),
					),
				)
				.run();
		} catch (error) {
			console.error(
				`move: workspace ${workspaceId} couldn't forget its old copy: ${messageOf(error)}`,
			);
		}
	}
}

function workspaceMove(db: Database, workspace: WorkspaceRef, to: string) {
	const { workspaceId } = workspace;
	const from = workspace.jurisdiction ?? "";
	const name = (conversationId: string) => conversationName(workspaceId, conversationId);
	const sandboxes = env.SANDBOX;
	return {
		registry: {
			from: objectsIn(env.REGISTRY, from).getByName(workspaceId),
			to: objectsIn(env.REGISTRY, to).getByName(workspaceId),
		},
		conversation: (conversationId: string) => ({
			from: objectsIn(env.CONVERSATIONS, from).getByName(name(conversationId)) as MoveSource,
			to: restarting(objectsIn(env.CONVERSATIONS, to).getByName(name(conversationId))),
		}),
		// A sandbox's container keeps nothing once it sleeps; what the sandbox keeps of its
		// conversation goes with it. The old one's container sleeps on its own.
		alongside: sandboxes
			? async (conversationId: string) => {
					const kept = await objectsIn(sandboxes, from).getByName(name(conversationId)).moveKeys();
					await objectsIn(sandboxes, to).getByName(name(conversationId)).takeKeys(kept);
				}
			: undefined,
		from,
		to,
		record: () => recordMove(db, workspace, to),
	};
}

/**
 * A new conversation's calls in a move. Its start restarts it, which can reach the caller before
 * the answer, as an error saying so: that means it started.
 */
function restarting(conversation: MoveTarget): MoveTarget {
	return {
		moveIn: (token, manifest) => conversation.moveIn(token, manifest),
		moveWrite: (token, page) => conversation.moveWrite(token, page),
		moveWriteKeys: (token, entries) => conversation.moveWriteKeys(token, entries),
		moveCheck: (token, manifest) => conversation.moveCheck(token, manifest),
		moveDigest: () => conversation.moveDigest(),
		async moveStart(from) {
			try {
				await conversation.moveStart(from);
			} catch (error) {
				if ((error instanceof Error ? error.message : String(error)) !== MOVED_IN) throw error;
			}
		},
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function recordMove(db: Database, from: WorkspaceRef, to: string): Promise<void> {
	const moved = { jurisdiction: to, movedFrom: from.jurisdiction ?? "", movedAt: Date.now() };
	await db
		.insert(schema.workspaceLocation)
		.values({ workspaceId: from.workspaceId, ...moved })
		.onConflictDoUpdate({ target: schema.workspaceLocation.workspaceId, set: moved })
		.run();
}

/**
 * Takes the deployment's sandbox meter to the jurisdiction: what the old one counted joins what
 * the new one has, and the old one forgets it. Registries report to the new one from the deploy
 * on, each with its workspace's whole month, so this only keeps the month's total whole.
 */
async function moveMeter(to: DurableObjectJurisdiction): Promise<void> {
	if (!env.SANDBOX_METER) return;
	const old = env.SANDBOX_METER.getByName(METER_NAME);
	const readings = await old.readings();
	if (readings.length === 0) return;
	await objectsIn(env.SANDBOX_METER, to).getByName(METER_NAME).takeReadings(readings);
	await old.clear();
}
