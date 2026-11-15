/**
 * The workspace's memory (AGT-107): notes its people and agents keep, which agents recall in
 * later runs. Members read them. Owners and admins add, edit and delete them, and approve or
 * dismiss the ones that wait: what an agent wrote in a run a trigger started, which no agent
 * recalls until someone has looked at it. Each change is in the audit log, with the start of the
 * memory's text at most.
 */
import {
	type Memory,
	type MemoryPage,
	type MemoryState,
	memoryEditInput,
	memoryExcerpt,
	memoryFilter,
	memoryInput,
	triggerOf,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const id = z.string().min(1).max(64);

/** What someone whose account is gone, or who left, is called on what they wrote. */
const FORMER_MEMBER = "A former member";

/** A memory with the names its ids have now. */
export interface MemoryEntry extends Memory {
	/** The person's or the agent's name. */
	authorName: string;
	/** The agent, repository or person it is about, by name; null for the workspace. */
	aboutName: string | null;
	approvedByName: string | null;
	editedByName: string | null;
	/** Whether the caller may open the run it was written in: admins any, members their own. */
	runVisible: boolean;
}

/** What a memory can be about, for the form that adds one. */
export interface MemoryTargets {
	agents: { id: string; name: string }[];
	repositories: { id: string; name: string }[];
	people: { id: string; name: string }[];
}

export interface MemoryList {
	memories: MemoryEntry[];
	counts: Record<MemoryState, number>;
	next: number | null;
	/** Only for owners and admins, who add memories. */
	targets: MemoryTargets | null;
}

async function memberOf(slug: string, admin: boolean) {
	const { currentMember } = await import("#/server/access");
	const { isAdmin } = await import("#/lib/roles");
	const member = await currentMember(slug);
	if (!member) return null;
	if (admin && !isAdmin(member.membership.role)) throw new Error("Only admins can do this");
	const [{ registryFor }, { auditFor }, { db }, { memberNames }] = await Promise.all([
		import("#/server/registry"),
		import("#/server/audit"),
		import("#/server/auth"),
		import("#/server/workspaces"),
	]);
	return {
		member,
		admin: isAdmin(member.membership.role),
		registry: registryFor(member.membership),
		audit: auditFor(member),
		names: () => memberNames(db, member.membership.workspaceId),
	};
}

function entry(
	memory: Memory,
	names: Map<string, string>,
	viewer: { id: string; admin: boolean },
): MemoryEntry {
	const person = (userId: string | null) =>
		userId === null ? null : (names.get(userId) ?? FORMER_MEMBER);
	return {
		...memory,
		authorName:
			memory.author.kind === "agent"
				? (memory.author.name ?? "A removed agent")
				: (person(memory.author.id) ?? FORMER_MEMBER),
		aboutName: memory.scope === "person" ? person(memory.scopeId) : memory.scopeName,
		approvedByName: person(memory.approvedBy),
		editedByName: person(memory.editedBy),
		// As the Runs page decides: a trigger's run is for owners and admins.
		runVisible:
			memory.run !== null &&
			(viewer.admin ||
				(memory.run.startedBy === viewer.id && triggerOf(memory.run.startedBy) === null)),
	};
}

/** The audit log's name for a memory: the start of its text, or nothing for one about a person. */
function target(memory: Memory) {
	return { type: "memory" as const, id: memory.id, label: memoryExcerpt(memory) };
}

/** A page of the workspace's memory. Null when the caller is not a member. */
export const getMemory = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), filter: memoryFilter }))
	.handler(async ({ data }): Promise<MemoryList | null> => {
		const found = await memberOf(data.slug, false);
		if (!found) return null;
		const { registry, admin } = found;
		const [page, names, agents, repositories]: [
			MemoryPage,
			Map<string, string>,
			{ id: string; name: string }[] | null,
			{ id: string; owner: string; name: string }[] | null,
		] = await Promise.all([
			registry.listMemories(data.filter),
			found.names(),
			admin ? registry.listRunnableAgents() : null,
			admin ? registry.listRepositories() : null,
		]);
		const viewer = { id: found.member.user.id, admin };
		return {
			memories: page.memories.map((memory) => entry(memory, names, viewer)),
			counts: page.counts,
			next: page.next,
			targets:
				agents && repositories
					? {
							agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
							repositories: repositories.map((repository) => ({
								id: repository.id,
								name: `${repository.owner}/${repository.name}`,
							})),
							people: [...names]
								.map(([userId, name]) => ({ id: userId, name }))
								.sort((a, b) => a.name.localeCompare(b.name)),
						}
					: null,
		};
	});

/** Adds a memory, which is trusted: an owner or admin wrote it. Returns its id. */
export const addMemory = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), memory: memoryInput }))
	.handler(async ({ data }): Promise<string> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		// The registry keeps no list of people, so who a memory may be about is checked here.
		if (data.memory.scope === "person" && !(await found.names()).has(data.memory.scopeId ?? "")) {
			throw new Error("That person is not a member of the workspace");
		}
		const added = await found.registry.addMemory(data.memory, found.member.user.id);
		if ("status" in added) throw new Error(added.message);
		await found.audit({
			action: "memory.added",
			target: target(added),
			detail: { kind: added.kind, scope: added.scope },
		});
		return added.id;
	});

export const editMemory = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), memory: memoryEditInput }))
	.handler(async ({ data }): Promise<void> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const edited = await found.registry.editMemory(data.memory, found.member.user.id);
		if (!edited) throw new Error("Memory not found");
		if ("status" in edited) throw new Error(edited.message);
		await found.audit({ action: "memory.edited", target: target(edited) });
	});

/** Makes a memory that waits trusted, so agents recall it. */
export const approveMemory = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), memoryId: id }))
	.handler(async ({ data }): Promise<void> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const approved = await found.registry.approveMemory(data.memoryId, found.member.user.id);
		if (!approved) throw new Error("Memory not found");
		if ("status" in approved) throw new Error(approved.message);
		await found.audit({ action: "memory.approved", target: target(approved) });
	});

/** Removes a memory that waits. */
export const dismissMemory = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), memoryId: id }))
	.handler(async ({ data }): Promise<void> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const dismissed = await found.registry.dismissMemory(data.memoryId);
		if (!dismissed) throw new Error("Memory not found");
		if ("status" in dismissed) throw new Error(dismissed.message);
		await found.audit({ action: "memory.dismissed", target: target(dismissed) });
	});

/** Removes a memory for good, from the search index too. */
export const deleteMemory = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), memoryId: id }))
	.handler(async ({ data }): Promise<boolean> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const deleted = await found.registry.deleteMemory(data.memoryId);
		if (deleted) await found.audit({ action: "memory.deleted", target: target(deleted) });
		return deleted !== null;
	});
