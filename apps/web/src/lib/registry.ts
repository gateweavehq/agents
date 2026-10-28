import {
	type Agent,
	type AssetDetail,
	type Overview,
	type Project,
	type ProjectDetail,
	projectInput,
	type Repository,
	type RepositoryDetail,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

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

/** How much the registry holds, and which runtimes each repository uses. */
export const getOverview = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({ data: slug }): Promise<{ counts: Overview; repositories: Repository[] } | null> => {
			const registry = await registryOf(slug);
			if (!registry) return null;
			const [{ projects, repositories, agents, assets }, list] = await Promise.all([
				registry.overview(),
				registry.listRepositories(),
			]);
			return { counts: { projects, repositories, agents, assets }, repositories: list };
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
