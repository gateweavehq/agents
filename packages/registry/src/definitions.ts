/**
 * Agents defined in the app and run by Gateweave. Each is a row in `agents` (the `gateweave`
 * runtime, no repository) with its definition beside it in `agent_definitions` and its MCP
 * servers in `agent_mcp_servers`, and reads its instructions, environment set and servers through
 * `agent_assets` like any agent, so the library asset's page lists it.
 * Removing one marks it removed, as scans do, so its id stays known.
 */
import {
	type Agent,
	type AgentSnapshot,
	type agentDefinitionInput,
	ENGINE_NAMES,
	ENGINE_PROVIDERS,
	INSTRUCTION_KINDS,
	MODEL_PROVIDER_NAMES,
	type ModelProvider,
	type SandboxRepository,
} from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import {
	agentAssets,
	agentDefinitions,
	agentMcpServers,
	agents,
	assets,
	repositories,
} from "./db/schema";
import { remoteServer } from "./mcp-servers";
import { getAssetVersion } from "./queries";
import { type Db, toAgent } from "./state";

/** A change to an agent that is refused, with a message fit to show the person who asked. */
export class AgentError extends Error {}

type Definition = z.output<typeof agentDefinitionInput>;

export function createAgent(db: Db, input: Definition, now: number): Agent {
	checkInstructions(db, input.instructions, null);
	checkEnvironment(db, input.environment, null);
	checkMcpServers(db, input.mcpServers, new Set());
	checkRepository(db, input, null);
	checkEngine(input);
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
	checkEnvironment(db, input.environment, current.envSetAssetId);
	checkMcpServers(db, input.mcpServers, pinnedServers(db, id));
	checkRepository(db, input, current.repositoryId);
	checkEngine(input);
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
		sandbox: definition.sandbox,
		engine: definition.engine,
		updatedAt: agent.updatedAt,
	};
}

/** The definition of a live agent run by Gateweave. */
function definitionOf(db: Db, id: string) {
	return db
		.select({
			instructionsAssetId: agentDefinitions.instructionsAssetId,
			envSetAssetId: agentDefinitions.envSetAssetId,
			repositoryId: agentDefinitions.repositoryId,
		})
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
		envSetAssetId: input.environment?.assetId ?? null,
		envSetVersion: input.environment?.version ?? null,
		sandbox: input.sandbox,
		repositoryId: input.repositoryId,
		engine: input.engine,
	};
}

/**
 * Makes the agent read exactly its instructions, environment set and MCP servers, and pins the
 * servers. Returns their asset ids.
 */
function linkInstructions(db: Db, agentId: string, input: Definition): string[] {
	db.delete(agentAssets).where(eq(agentAssets.agentId, agentId)).run();
	db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).run();
	for (const pin of input.mcpServers)
		db.insert(agentMcpServers)
			.values({ agentId, assetId: pin.assetId, version: pin.version, tools: pin.tools })
			.run();
	const assetIds = [
		input.instructions?.assetId,
		input.environment?.assetId,
		...input.mcpServers.map((pin) => pin.assetId),
	].filter((assetId): assetId is string => assetId !== undefined);
	for (const assetId of assetIds) db.insert(agentAssets).values({ agentId, assetId }).run();
	return assetIds;
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
	const asset = checkPin(db, pin, pinnedAssetId, (name, kind) =>
		(INSTRUCTION_KINDS as readonly string[]).includes(kind)
			? null
			: `${name} is not instructions or a prompt`,
	);
	if (getAssetVersion(db, pin.assetId, pin.version)?.files.some((file) => file.content === null)) {
		throw new AgentError(`${asset.name} has a file that is not text or is too large to read`);
	}
}

/** The environment set must be a version of a library asset of kind `env-set`; the same leave rule. */
function checkEnvironment(
	db: Db,
	pin: Definition["environment"],
	pinnedAssetId: string | null,
): void {
	if (!pin) return;
	checkPin(db, pin, pinnedAssetId, (name, kind) =>
		kind === "env-set" ? null : `${name} is not an environment set`,
	);
}

/**
 * The repository must be one the workspace's GitHub App reaches, and the agent must have a
 * sandbox to check it out in. Like an asset, a repository the app no longer reaches stays chosen
 * if it was, and the agent's turns say why they cannot go on, but it cannot be chosen anew.
 */
function checkRepository(db: Db, input: Definition, chosenId: string | null): void {
	if (input.repositoryId === null) return;
	if (!input.sandbox) {
		throw new AgentError(
			"Only an agent with a sandbox can have a repository: it is checked out there",
		);
	}
	const repository = db
		.select()
		.from(repositories)
		.where(eq(repositories.id, input.repositoryId))
		.get();
	if (!repository) throw new AgentError("There is no such repository in the workspace");
	if (repository.id === chosenId) return;
	const problem = repositoryProblem(repository);
	if (problem) throw new AgentError(problem);
}

/** Why the workspace's GitHub App cannot check out a repository for a sandbox; null if it can. */
function repositoryProblem(repository: typeof repositories.$inferSelect): string | null {
	const name = `${repository.owner}/${repository.name}`;
	if (repository.provider !== "github" || repository.installationId === null) {
		return `${name} is not reached through the workspace's GitHub App`;
	}
	if (repository.removedAt !== null) return `The workspace's GitHub App no longer reaches ${name}`;
	return null;
}

/**
 * What an engine run in the sandbox needs, each rule in words the person can act on: the sandbox,
 * and a model of its provider, such as Anthropic's for Claude Code. Gateweave's loop has no rules
 * of its own.
 */
function checkEngine(input: Definition): void {
	if (input.engine === "gateweave") return;
	const name = ENGINE_NAMES[input.engine];
	if (!input.sandbox) {
		throw new AgentError(`${name} runs in the agent's sandbox: turn the sandbox on`);
	}
	const providers: readonly ModelProvider[] = ENGINE_PROVIDERS[input.engine];
	if (!providers.includes(input.provider)) {
		const names = providers.map((provider) => `${MODEL_PROVIDER_NAMES[provider]}'s`);
		const last = names.pop();
		const list = names.length > 0 ? `${names.join(", ")} or ${last}` : last;
		throw new AgentError(`${name} calls ${list} models: choose one of them`);
	}
}

/**
 * The repository the agent's sandbox checks out, as a turn hands it to the runtime, or why it
 * cannot be; null when the agent has none.
 */
export function agentRepository(
	db: Db,
	agentId: string,
): SandboxRepository | { problem: string } | null {
	const found = db
		.select({ repository: repositories })
		.from(agentDefinitions)
		.innerJoin(repositories, eq(repositories.id, agentDefinitions.repositoryId))
		.where(eq(agentDefinitions.agentId, agentId))
		.get();
	if (!found) return null;
	const { repository } = found;
	const problem = repositoryProblem(repository);
	if (problem || repository.installationId === null) {
		return { problem: problem ?? "The repository cannot be reached" };
	}
	return {
		owner: repository.owner,
		name: repository.name,
		externalId: repository.externalId,
		installationId: repository.installationId,
		defaultBranch: repository.defaultBranch,
	};
}

/** The servers the agent pins now, which may stay pinned after they leave the library. */
function pinnedServers(db: Db, agentId: string): Set<string> {
	return new Set(
		db
			.select({ assetId: agentMcpServers.assetId })
			.from(agentMcpServers)
			.where(eq(agentMcpServers.agentId, agentId))
			.all()
			.map((row) => row.assetId),
	);
}

/**
 * Each MCP server must be a version of a library asset of kind `mcp-server` that an agent can
 * reach (see `remoteServer`); the same leave rule.
 */
function checkMcpServers(db: Db, pins: Definition["mcpServers"], pinned: Set<string>): void {
	for (const pin of pins) {
		const asset = checkPin(db, pin, pinned.has(pin.assetId) ? pin.assetId : null, (name, kind) =>
			kind === "mcp-server" ? null : `${name} is not an MCP server`,
		);
		const reading = remoteServer(getAssetVersion(db, pin.assetId, pin.version)?.files ?? []);
		if ("problem" in reading) throw new AgentError(`${asset.name}: ${reading.problem}`);
	}
}

/** The library asset a pin names, once it is known to be pinnable: of the right kind, there, with the version. */
function checkPin(
	db: Db,
	pin: { assetId: string; version: number },
	pinnedAssetId: string | null,
	wrongKind: (name: string, kind: string) => string | null,
): { name: string; kind: string } {
	const asset = db
		.select({ name: assets.name, kind: assets.kind, removedAt: assets.removedAt })
		.from(assets)
		.where(and(eq(assets.id, pin.assetId), isNull(assets.repositoryId)))
		.get();
	if (!asset) throw new AgentError("That library asset does not exist");
	const refusal = wrongKind(asset.name, asset.kind);
	if (refusal) throw new AgentError(refusal);
	if (asset.removedAt !== null && pin.assetId !== pinnedAssetId) {
		throw new AgentError(`${asset.name} is no longer in the library`);
	}
	if (!getAssetVersion(db, pin.assetId, pin.version)) {
		throw new AgentError(`${asset.name} has no version ${pin.version}`);
	}
	return asset;
}
