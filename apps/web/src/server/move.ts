import { env } from "cloudflare:workers";
import {
	METER_NAME,
	type MoveSource,
	type MoveTarget,
	moveWorkspace,
	objectsIn,
} from "@gateweave/agents-registry";
import { conversationName, MOVED_IN } from "@gateweave/agents-runtime";
import { asc, eq, isNull, ne, or } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { deploymentJurisdiction } from "./jurisdiction";
import type { WorkspaceRef } from "./workspaces";

// "Where a workspace lives" in docs/architecture.md.

/**
 * How many workspaces one daily run moves. Each conversation takes about a dozen calls to the two
 * objects, of the thousand a Worker on the Free plan may make to Cloudflare's services; the Paid
 * plan allows ten thousand.
 */
const MOVES_PER_RUN = 3;

/**
 * Moves workspaces whose Durable Objects are outside the deployment's jurisdiction into it, the
 * oldest first, a few each run: the registry and every conversation, with what each conversation's
 * sandbox keeps. Each workspace is paused for the seconds its copy takes; one with a turn under way
 * waits for the next run. The old objects are sealed and keep what the workspace held until it is
 * deleted. The deployment's sandbox meter moves first.
 */
export async function moveWorkspaces(db: Database): Promise<void> {
	const target = deploymentJurisdiction();
	if (!target) return;
	try {
		await moveMeter(target);
	} catch (error) {
		console.error(`move: the sandbox meter didn't move to ${target}`, error);
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
			or(
				isNull(schema.workspaceLocation.jurisdiction),
				ne(schema.workspaceLocation.jurisdiction, target),
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
			console.error(`move: workspace ${workspace.workspaceId} didn't move to ${target}`, error);
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
