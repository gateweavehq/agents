/**
 * Agents defined in the app and run by Gateweave. Each is a row in `agents` (the `gateweave`
 * runtime, no repository) with its definition beside it in `agent_definitions`, and reads its
 * instructions through `agent_assets` like any agent, so the library asset's page lists it.
 * Removing one marks it removed, as scans do, so its id stays known.
 */
import {
	type Agent,
	type AgentSnapshot,
	type agentDefinitionInput,
	INSTRUCTION_KINDS,
} from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { agentAssets, agentDefinitions, agents, assets } from "./db/schema";
import { getAssetVersion } from "./queries";
import { type Db, toAgent } from "./state";

/** A change to an agent that is refused, with a message fit to show the person who asked. */
export class AgentError extends Error {}

type Definition = z.output<typeof agentDefinitionInput>;

export function createAgent(db: Db, input: Definition, now: number): Agent {
	checkInstructions(db, input.instructions, null);
	const id = crypto.randomUUID();
	const row = {
		id,
		repositoryId: null,
		runtime: "gateweave" as const,
		key: id,
		name: input.name,
		description: input.description,
		model: input.model,
		path: null,
		metadata: {},
		createdAt: now,
		updatedAt: now,
		removedAt: null,
	};
	db.insert(agents).values(row).run();
	db.insert(agentDefinitions).values(definitionRow(id, input)).run();
	return toAgent(row, linkInstructions(db, id, input));
}

/** Null when there is no such agent run by Gateweave. */
export function updateAgent(db: Db, id: string, input: Definition, now: number): Agent | null {
	const current = definitionOf(db, id);
	if (!current) return null;
	checkInstructions(db, input.instructions, current.instructionsAssetId);
	const row = db
		.update(agents)
		.set({
			name: input.name,
			description: input.description,
			model: input.model,
			updatedAt: now,
		})
		.where(eq(agents.id, id))
		.returning()
		.get();
	if (!row) return null;
	db.update(agentDefinitions)
		.set(definitionRow(id, input))
		.where(eq(agentDefinitions.agentId, id))
		.run();
	return toAgent(row, linkInstructions(db, id, input));
}

export function removeAgent(db: Db, id: string, now: number): boolean {
	if (!definitionOf(db, id)) return false;
	db.update(agents).set({ removedAt: now, updatedAt: now }).where(eq(agents.id, id)).run();
	return true;
}

/** Null when there is no such agent run by Gateweave. */
export function agentSnapshot(db: Db, id: string): AgentSnapshot | null {
	const found = db
		.select({ agent: agents, definition: agentDefinitions })
		.from(agents)
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.where(and(eq(agents.id, id), isNull(agents.removedAt)))
		.get();
	if (!found) return null;
	const { agent, definition } = found;
	const { instructionsAssetId: assetId, instructionsVersion: version } = definition;
	const files =
		assetId !== null && version !== null
			? (getAssetVersion(db, assetId, version)?.files ?? [])
			: [];
	return {
		agentId: agent.id,
		name: agent.name,
		provider: definition.provider,
		model: definition.model,
		// Pinning checked that every file has text, and a version never changes.
		instructions: files.length > 0 ? files.map((file) => file.content ?? "").join("\n\n") : null,
		updatedAt: agent.updatedAt,
	};
}

/** The definition of a live agent run by Gateweave. */
function definitionOf(db: Db, id: string) {
	return db
		.select({ instructionsAssetId: agentDefinitions.instructionsAssetId })
		.from(agentDefinitions)
		.innerJoin(agents, eq(agents.id, agentDefinitions.agentId))
		.where(and(eq(agentDefinitions.agentId, id), isNull(agents.removedAt)))
		.get();
}

function definitionRow(agentId: string, input: Definition) {
	return {
		agentId,
		provider: input.provider,
		model: input.model,
		instructionsAssetId: input.instructions?.assetId ?? null,
		instructionsVersion: input.instructions?.version ?? null,
	};
}

/** Makes the agent read exactly its instructions. Returns the ids of the assets it reads. */
function linkInstructions(db: Db, agentId: string, input: Definition): string[] {
	db.delete(agentAssets).where(eq(agentAssets.agentId, agentId)).run();
	if (!input.instructions) return [];
	db.insert(agentAssets).values({ agentId, assetId: input.instructions.assetId }).run();
	return [input.instructions.assetId];
}

/**
 * Instructions must be a version of a library asset of one of `INSTRUCTION_KINDS`, all of it
 * text the agent can read. As with setups, an asset that has left the library keeps the pin it
 * had but cannot be pinned anew.
 */
function checkInstructions(
	db: Db,
	pin: Definition["instructions"],
	pinnedAssetId: string | null,
): void {
	if (!pin) return;
	const asset = db
		.select({ name: assets.name, kind: assets.kind, removedAt: assets.removedAt })
		.from(assets)
		.where(and(eq(assets.id, pin.assetId), isNull(assets.repositoryId)))
		.get();
	if (!asset) throw new AgentError("That library asset does not exist");
	if (!(INSTRUCTION_KINDS as readonly string[]).includes(asset.kind)) {
		throw new AgentError(`${asset.name} is not instructions or a prompt`);
	}
	if (asset.removedAt !== null && pin.assetId !== pinnedAssetId) {
		throw new AgentError(`${asset.name} is no longer in the library`);
	}
	const version = getAssetVersion(db, pin.assetId, pin.version);
	if (!version) throw new AgentError(`${asset.name} has no version ${pin.version}`);
	if (version.files.some((file) => file.content === null)) {
		throw new AgentError(`${asset.name} has a file that is not text or is too large to read`);
	}
}
