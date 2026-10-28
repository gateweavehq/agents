import {
	type Agent,
	type AgentDetail,
	type ApplyOutcome,
	type AssetDetail,
	type AssetKind,
	agentDefinitionInput,
	type LibraryEntry,
	libraryEditInput,
	libraryTarget,
	type McpServerInput,
	MODEL_PROVIDERS,
	mcpServerEditInput,
	mcpServerInput,
	type Overview,
	type Project,
	type ProjectDetail,
	type ProviderModel,
	projectInput,
	type Repository,
	type RepositoryDetail,
	type RepositoryRuntime,
	type RunUsage,
	type Setup,
	type SetupDetail,
	type SetupEntry,
	setupInput,
	setupPins,
	writtenAssetInput,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { FileDiff } from "#/lib/version-diff";

const id = z.string().min(1).max(64);

/** The registry of the workspace `slug`, or null if the caller may not see the workspace. */
async function registryOf(slug: string) {
	const { currentMember } = await import("#/server/access");
	const member = await currentMember(slug);
	if (!member) return null;
	const { registryFor } = await import("#/server/registry");
	return registryFor(member.membership.workspaceId);
}

/** The registry of the workspace `slug`, for changes only owners and admins may make. */
async function managedRegistryOf(slug: string) {
	const { currentMember } = await import("#/server/access");
	const { isAdmin } = await import("#/lib/roles");
	const member = await currentMember(slug);
	if (!member || !isAdmin(member.membership.role)) throw new Error("Only admins can do this");
	const { registryFor } = await import("#/server/registry");
	return registryFor(member.membership.workspaceId);
}

/** The span of time the Overview sums the workspace's runs over. */
const USAGE_PERIOD = 30 * 24 * 60 * 60 * 1000;

/**
 * How much the registry holds, which runtimes each repository uses, and what the agents run by
 * Gateweave used lately.
 */
export const getOverview = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({
			data: slug,
		}): Promise<{ counts: Overview; repositories: Repository[]; usage: RunUsage } | null> => {
			const registry = await registryOf(slug);
			if (!registry) return null;
			const [{ projects, repositories, agents, assets }, list, usage] = await Promise.all([
				registry.overview(),
				registry.listRepositories(),
				registry.runUsage(Date.now() - USAGE_PERIOD),
			]);
			return { counts: { projects, repositories, agents, assets }, repositories: list, usage };
		},
	);

export const getRepositories = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<Repository[] | null> => {
		const registry = await registryOf(slug);
		return registry ? registry.listRepositories() : null;
	});

export const getRepository = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), repositoryId: id }))
	.handler(async ({ data }): Promise<RepositoryDetail | null> => {
		const registry = await registryOf(data.slug);
		return registry ? registry.getRepository(data.repositoryId) : null;
	});

/** Every agent, with the repositories they are in. */
export const getAgents = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({ data: slug }): Promise<{ agents: Agent[]; repositories: Repository[] } | null> => {
			const registry = await registryOf(slug);
			if (!registry) return null;
			const [agents, repositories] = await Promise.all([
				registry.listAgents(),
				registry.listRepositories(),
			]);
			return { agents, repositories };
		},
	);

export const getAgent = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), agentId: id }))
	.handler(async ({ data }): Promise<AgentDetail | null> => {
		const registry = await registryOf(data.slug);
		return registry ? registry.getAgent(data.agentId) : null;
	});

/** Defines an agent run by Gateweave. */
export const createAgent = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), agent: agentDefinitionInput }))
	.handler(async ({ data }): Promise<Agent> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.createAgent(data.agent);
	});

export const updateAgent = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), agentId: id, agent: agentDefinitionInput }))
	.handler(async ({ data }): Promise<Agent> => {
		const registry = await managedRegistryOf(data.slug);
		const agent = await registry.updateAgent(data.agentId, data.agent);
		if (!agent) throw new Error("Agent not found");
		return agent;
	});

export const removeAgent = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), agentId: id }))
	.handler(async ({ data }): Promise<void> => {
		const registry = await managedRegistryOf(data.slug);
		await registry.removeAgent(data.agentId);
	});

/** The models the workspace's key for `provider` can use, to choose an agent's model from. */
export const getModels = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), provider: z.enum(MODEL_PROVIDERS) }))
	.handler(async ({ data }): Promise<ProviderModel[]> => {
		const registry = await managedRegistryOf(data.slug);
		const models = await registry.listModels(data.provider);
		if ("status" in models) throw new Error(models.message);
		return models;
	});

export const getAsset = createServerFn({ method: "GET" })
	.validator(
		z.object({
			slug: z.string().min(1),
			assetId: id,
			version: z.number().int().positive().optional(),
		}),
	)
	.handler(async ({ data }): Promise<AssetDetail | null> => {
		const registry = await registryOf(data.slug);
		return registry ? registry.getAsset(data.assetId, data.version) : null;
	});

/**
 * Queues a scan of one repository that reads it even if nothing was pushed, for after the
 * adapters learn something new. Any member may ask; a scan only reads.
 */
export const scanRepository = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), repositoryId: id }))
	.handler(async ({ data }): Promise<boolean> => {
		const registry = await registryOf(data.slug);
		if (!registry) throw new Error("Workspace not found");
		return (await registry.requestScans([data.repositoryId], true)) > 0;
	});

/** Every project, with the repositories they can be given. */
export const getProjects = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({ data: slug }): Promise<{ projects: Project[]; repositories: Repository[] } | null> => {
			const registry = await registryOf(slug);
			if (!registry) return null;
			const [projects, repositories] = await Promise.all([
				registry.listProjects(),
				registry.listRepositories(),
			]);
			return { projects, repositories };
		},
	);

export const getProject = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), projectId: id }))
	.handler(async ({ data }): Promise<ProjectDetail | null> => {
		const registry = await registryOf(data.slug);
		return registry ? registry.getProject(data.projectId) : null;
	});

export const createProject = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), project: projectInput }))
	.handler(async ({ data }): Promise<Project> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.createProject(data.project);
	});

export const updateProject = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), projectId: id, project: projectInput }))
	.handler(async ({ data }): Promise<Project> => {
		const registry = await managedRegistryOf(data.slug);
		const project = await registry.updateProject(data.projectId, data.project);
		if (!project) throw new Error("Project not found");
		return project;
	});

export const deleteProject = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), projectId: id }))
	.handler(async ({ data }): Promise<void> => {
		const registry = await managedRegistryOf(data.slug);
		await registry.deleteProject(data.projectId);
	});

/** Gives a project exactly these repositories. */
export const setProjectRepositories = createServerFn({ method: "POST" })
	.validator(
		z.object({ slug: z.string().min(1), projectId: id, repositoryIds: z.array(id).max(1000) }),
	)
	.handler(async ({ data }): Promise<Project> => {
		const registry = await managedRegistryOf(data.slug);
		const project = await registry.setProjectRepositories(data.projectId, data.repositoryIds);
		if (!project) throw new Error("Project not found");
		return project;
	});

export const getLibrary = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<LibraryEntry[] | null> => {
		const registry = await registryOf(slug);
		return registry ? registry.listLibrary() : null;
	});

/** Copies a repository asset into the library. Returns the library asset's id. */
export const addToLibrary = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), assetId: id, target: libraryTarget }))
	.handler(async ({ data }): Promise<string> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.addToLibrary(data.assetId, data.target);
	});

export const removeFromLibrary = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), assetId: id }))
	.handler(async ({ data }): Promise<void> => {
		const registry = await managedRegistryOf(data.slug);
		await registry.removeFromLibrary(data.assetId);
	});

/** Creates a library asset from text typed in the app. Returns its id. */
export const createLibraryAsset = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), asset: writtenAssetInput }))
	.handler(async ({ data }): Promise<string> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.createLibraryAsset(data.asset);
	});

/** Saves new text for a library asset's files. Returns the version it is at now. */
export const editLibraryAsset = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), edit: libraryEditInput }))
	.handler(async ({ data }): Promise<number> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.editLibraryAsset(data.edit);
	});

/** Adds a remote MCP server to the library from its settings. Returns its id. */
export const createMcpServer = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), server: mcpServerInput }))
	.handler(async ({ data }): Promise<string> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.createMcpServer(data.server);
	});

/** Saves a library MCP server's settings as its next version. Returns the version it is at now. */
export const editMcpServer = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), server: mcpServerEditInput }))
	.handler(async ({ data }): Promise<number> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.editMcpServer(data.server);
	});

/**
 * The settings of a library MCP server's current version, for its form: each header's variable
 * written as a reference again. Null for one the form cannot hold, such as a local command.
 */
export const getMcpSettings = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), assetId: id }))
	.handler(async ({ data }): Promise<Omit<McpServerInput, "name"> | null> => {
		const registry = await registryOf(data.slug);
		const detail = await registry?.getAsset(data.assetId);
		if (detail?.asset.kind !== "mcp-server" || detail.asset.repositoryId !== null) {
			return null;
		}
		const { readMcpConnection } = await import("@gateweave/agents-adapters");
		const reading = readMcpConnection(detail.version.files);
		if (!reading.ok || reading.connection.transport === "stdio") return null;
		const { transport, url, headers } = reading.connection;
		return {
			transport,
			url,
			headers: headers.map(({ name, value }) => ({
				name,
				value: typeof value === "string" ? value : `${value.prefix}\${${value.variable}}`,
			})),
		};
	});

/** The files that differ between two versions of an asset, as line diffs. */
export const getVersionDiff = createServerFn({ method: "GET" })
	.validator(
		z.object({
			slug: z.string().min(1),
			assetId: id,
			from: z.number().int().positive(),
			to: z.number().int().positive(),
		}),
	)
	.handler(async ({ data }): Promise<FileDiff[] | null> => {
		const registry = await registryOf(data.slug);
		if (!registry) return null;
		const [from, to] = await Promise.all([
			registry.getAssetVersion(data.assetId, data.from),
			registry.getAssetVersion(data.assetId, data.to),
		]);
		if (!from || !to) return null;
		// Imported here so the diff library stays out of the browser bundle.
		const { diffFiles } = await import("#/lib/version-diff");
		return diffFiles(from.files, to.files);
	});

/** Every setup, with how many assets it pins and how many have updates. */
export const getSetups = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<SetupEntry[] | null> => {
		const registry = await registryOf(slug);
		return registry ? registry.listSetups() : null;
	});

export const getSetup = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), setupId: id }))
	.handler(async ({ data }): Promise<SetupDetail | null> => {
		const registry = await registryOf(data.slug);
		return registry ? registry.getSetup(data.setupId) : null;
	});

export const createSetup = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), setup: setupInput }))
	.handler(async ({ data }): Promise<Setup> => {
		const registry = await managedRegistryOf(data.slug);
		return registry.createSetup(data.setup);
	});

/** A ready-made setup, as the Setups page lists it. */
export interface ReadyMadeSummary {
	slug: string;
	name: string;
	description: string | null;
	runtimes: RepositoryRuntime[];
	assets: { kind: AssetKind; name: string }[];
}

/** The setups that ship with the app, for any member to see. */
export const getReadyMadeSetups = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<ReadyMadeSummary[] | null> => {
		const registry = await registryOf(slug);
		if (!registry) return null;
		const { readyMadeSetups } = await import("#/server/ready-made");
		return readyMadeSetups().map(({ slug: folder, setup }) => ({
			slug: folder,
			name: setup.name,
			description: setup.description,
			runtimes: setup.runtimes,
			assets: setup.assets.map(({ kind, name }) => ({ kind, name })),
		}));
	});

/** Adds a ready-made setup to the workspace and returns the new setup's id. */
export const addReadyMadeSetup = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), setup: z.string().min(1).max(100) }))
	.handler(async ({ data }): Promise<string> => {
		const registry = await managedRegistryOf(data.slug);
		const { importInputOf, readyMadeSetups } = await import("#/server/ready-made");
		const found = readyMadeSetups().find((candidate) => candidate.slug === data.setup);
		if (!found) throw new Error("There is no such ready-made setup");
		return registry.importSetup(importInputOf(found));
	});

export const updateSetup = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), setupId: id, setup: setupInput }))
	.handler(async ({ data }): Promise<Setup> => {
		const registry = await managedRegistryOf(data.slug);
		const setup = await registry.updateSetup(data.setupId, data.setup);
		if (!setup) throw new Error("Setup not found");
		return setup;
	});

export const deleteSetup = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), setupId: id }))
	.handler(async ({ data }): Promise<void> => {
		const registry = await managedRegistryOf(data.slug);
		await registry.deleteSetup(data.setupId);
	});

/**
 * Opens a pull request that writes the setup into a repository, or gives the open one a new
 * commit. The pull request links back to the setup's page.
 */
export const applySetup = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), setupId: id, repositoryId: id }))
	.handler(async ({ data }): Promise<ApplyOutcome> => {
		const registry = await managedRegistryOf(data.slug);
		const { appOrigin } = await import("#/server/origin");
		const path = `/${encodeURIComponent(data.slug)}/setups/${encodeURIComponent(data.setupId)}`;
		const outcome = await registry.applySetup(
			data.setupId,
			data.repositoryId,
			`${appOrigin()}${path}`,
		);
		if (outcome.status === "refused") throw new Error(outcome.message);
		return outcome;
	});

/** Gives a setup exactly these library assets, each pinned to a version. */
export const setSetupAssets = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), setupId: id, pins: setupPins }))
	.handler(async ({ data }): Promise<Setup> => {
		const registry = await managedRegistryOf(data.slug);
		const setup = await registry.setSetupAssets(data.setupId, data.pins);
		if (!setup) throw new Error("Setup not found");
		return setup;
	});
