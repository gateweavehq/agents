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
	FILES_NEED_REPOSITORY,
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
import { storedServer } from "./mcp-servers";
import { getAssetVersion } from "./queries";
import { type Db, toAgent } from "./state";

/** A change to an agent that is refused, with a message fit to show the person who asked. */
export class AgentError extends Error {}

type Definition = z.output<typeof agentDefinitionInput>;

export function createAgent(db: Db, input: Definition, now: number): Agent {
	checkInstructions(db, input.instructions, null);
	checkEnvironment(db, input.environment, null);
	checkMcpServers(db, input, new Set());
	checkRepository(db, input, null);
	checkEngine(input);
	checkFiles(input);
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
	checkMcpServers(db, input, pinnedServers(db, id));
	checkRepository(db, input, current.repositoryId);
	checkEngine(input);
	checkFiles(input);
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

/** A pin an agent moved, for the audit log: which of its fields, and the asset by name. */
export interface MovedPin {
	agent: Agent;
	field: "instructions" | "environment" | "mcpServers";
	asset: string;
	/** The version it was pinned to, and the one it is pinned to now. */
	from: number;
	version: number;
}

/**
 * Moves one pin of an agent to another version of the asset it pins, by the rules an update
 * applies to that pin, and leaves the rest of the definition as it is: unlike an update, it takes
 * nothing else, so it can reset nothing else. Null when there is no such agent run by Gateweave.
 */
export function moveAgentPin(
	db: Db,
	id: string,
	pin: { assetId: string; version: number },
	now: number,
): MovedPin | null {
	const current = db
		.select({
			instructionsAssetId: agentDefinitions.instructionsAssetId,
			instructionsVersion: agentDefinitions.instructionsVersion,
			envSetAssetId: agentDefinitions.envSetAssetId,
			envSetVersion: agentDefinitions.envSetVersion,
			sandbox: agentDefinitions.sandbox,
		})
		.from(agentDefinitions)
		.innerJoin(agents, eq(agents.id, agentDefinitions.agentId))
		.where(and(eq(agentDefinitions.agentId, id), isNull(agents.removedAt)))
		.get();
	if (!current) return null;
	const server = db
		.select({ version: agentMcpServers.version })
		.from(agentMcpServers)
		.where(and(eq(agentMcpServers.agentId, id), eq(agentMcpServers.assetId, pin.assetId)))
		.get();
	// Read before anything is written: past this point the move either ends whole or throws,
	// which undoes it, so it never answers as if there were no agent with the pin moved.
	const asset = db
		.select({ name: assets.name })
		.from(assets)
		.where(eq(assets.id, pin.assetId))
		.get();
	if (!asset) throw new AgentError("That library asset does not exist");
	let moved: Pick<MovedPin, "field" | "from">;
	if (current.instructionsAssetId === pin.assetId && current.instructionsVersion !== null) {
		checkInstructions(db, pin, pin.assetId);
		db.update(agentDefinitions)
			.set({ instructionsVersion: pin.version })
			.where(eq(agentDefinitions.agentId, id))
			.run();
		moved = { field: "instructions", from: current.instructionsVersion };
	} else if (current.envSetAssetId === pin.assetId && current.envSetVersion !== null) {
		checkEnvironment(db, pin, pin.assetId);
		db.update(agentDefinitions)
			.set({ envSetVersion: pin.version })
			.where(eq(agentDefinitions.agentId, id))
			.run();
		moved = { field: "environment", from: current.envSetVersion };
	} else if (server) {
		// The check reads the pin's version and the sandbox only, so the tools it keeps stay out.
		checkMcpServers(
			db,
			{ mcpServers: [{ ...pin, tools: null }], sandbox: current.sandbox },
			new Set([pin.assetId]),
		);
		db.update(agentMcpServers)
			.set({ version: pin.version })
			.where(and(eq(agentMcpServers.agentId, id), eq(agentMcpServers.assetId, pin.assetId)))
			.run();
		moved = { field: "mcpServers", from: server.version };
	} else {
		throw new AgentError("The agent does not pin that asset");
	}
	const row = db.update(agents).set({ updatedAt: now }).where(eq(agents.id, id)).returning().get();
	if (!row) throw new Error("The agent whose pin moved is gone");
	const assetIds = db
		.select({ assetId: agentAssets.assetId })
		.from(agentAssets)
		.where(eq(agentAssets.agentId, id))
		.all()
		.map((link) => link.assetId);
	return { agent: toAgent(row, assetIds), ...moved, asset: asset.name, version: pin.version };
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
		memory: definition.memory,
		// Left out of an agent without it, whose snapshot is then what it always was.
		...(definition.files ? { files: true as const } : {}),
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
		memory: input.memory,
		files: input.files,
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
 * sandbox to check it out in, or work on its files without one. Like an asset, a repository the
 * app no longer reaches stays chosen if it was, and the agent's turns say why they cannot go on,
 * but it cannot be chosen anew.
 */
function checkRepository(
	db: Db,
	input: Pick<Definition, "repositoryId" | "sandbox" | "files">,
	chosenId: string | null,
): void {
	if (input.repositoryId === null) return;
	// The words name the sandbox alone until a form offers the other way to have one.
	if (!input.sandbox && !input.files) {
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
	const problem = repositoryProblem(repository, input.files);
	if (problem) throw new AgentError(problem);
}

/**
 * Why the workspace's GitHub App cannot check out a repository for a sandbox, or read it for an
 * agent that works on its `files` without one; null if it can. Each is told in its own words
 * where they differ: an agent without a sandbox is not told what sandboxes do.
 */
function repositoryProblem(
	repository: typeof repositories.$inferSelect,
	files: boolean,
): string | null {
	const name = `${repository.owner}/${repository.name}`;
	if (repository.provider === "gitlab") {
		return files
			? `${name} is on GitLab: an agent works on the files of GitHub repositories only, for now`
			: `${name} is on GitLab: sandboxes check out GitHub repositories only, for now`;
	}
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
function checkEngine(input: Pick<Definition, "engine" | "provider" | "sandbox">): void {
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
 * What working on a repository's files without a sandbox needs besides what `checkEngine` and
 * `checkMcpServers` already hold for any agent without one: Gateweave's own loop, and no MCP
 * server that runs as a local command. There is nothing else for such a turn to work on, so it
 * needs the repository. That it never comes with a sandbox is the input schema's rule.
 */
function checkFiles(input: Pick<Definition, "files" | "repositoryId">): void {
	if (input.files && input.repositoryId === null) throw new AgentError(FILES_NEED_REPOSITORY);
}

/**
 * What `createAgent` would refuse about an agent that works in a sandbox on a repository, said
 * before anything is made: Connect Track checks it before the browser leaves, by the very rules
 * the write applies after it comes back. Throws an `AgentError`.
 */
export function checkSandboxChoices(
	db: Db,
	choices: Pick<Definition, "repositoryId" | "engine" | "provider">,
): void {
	const input = { ...choices, sandbox: true, files: false };
	checkRepository(db, input, null);
	checkEngine(input);
}

/**
 * The repository the agent's sandbox checks out, or its turns read their files from, as a turn
 * hands it to the runtime, or why it cannot be; null when the agent has none.
 */
export function agentRepository(
	db: Db,
	agentId: string,
): SandboxRepository | { problem: string } | null {
	const found = db
		.select({ repository: repositories, files: agentDefinitions.files })
		.from(agentDefinitions)
		.innerJoin(repositories, eq(repositories.id, agentDefinitions.repositoryId))
		.where(eq(agentDefinitions.agentId, agentId))
		.get();
	if (!found) return null;
	const { repository } = found;
	const problem = repositoryProblem(repository, found.files);
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
 * reach (see `storedServer`): one that runs as a local command only with the agent's sandbox,
 * which starts it. The same leave rule.
 */
function checkMcpServers(
	db: Db,
	{ mcpServers: pins, sandbox }: Pick<Definition, "mcpServers" | "sandbox">,
	pinned: Set<string>,
): void {
	for (const pin of pins) {
		const asset = checkPin(db, pin, pinned.has(pin.assetId) ? pin.assetId : null, (name, kind) =>
			kind === "mcp-server" ? null : `${name} is not an MCP server`,
		);
		const reading = storedServer(getAssetVersion(db, pin.assetId, pin.version)?.files ?? []);
		if ("problem" in reading) throw new AgentError(`${asset.name}: ${reading.problem}`);
		if (reading.server.transport === "stdio" && !sandbox) {
			throw new AgentError(
				`${asset.name} runs as a local command, which starts in the agent's sandbox: turn the sandbox on`,
			);
		}
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
