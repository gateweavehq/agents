import type { Project, projectInput, projectPatch } from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { projectRepositories, projects, repositories } from "./db/schema";
import { findProject } from "./queries";
import type { Db } from "./state";

export function createProject(db: Db, input: z.output<typeof projectInput>, now: number): Project {
	const row = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
	db.insert(projects).values(row).run();
	return { ...row, repositoryIds: [] };
}

export function updateProject(
	db: Db,
	id: string,
	patch: z.output<typeof projectPatch>,
	now: number,
): Project | null {
	const updated = db
		.update(projects)
		.set({ ...patch, updatedAt: now })
		.where(eq(projects.id, id))
		.returning({ id: projects.id })
		.get();
	return updated ? findProject(db, id) : null;
}

export function deleteProject(db: Db, id: string): boolean {
	db.delete(projectRepositories).where(eq(projectRepositories.projectId, id)).run();
	return (
		db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id }).get() !==
		undefined
	);
}

/** Replaces the project's repositories. Ids of missing or removed repositories are skipped. */
export function setProjectRepositories(
	db: Db,
	projectId: string,
	repositoryIds: string[],
	now: number,
): Project | null {
	if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()) {
		return null;
	}
	db.delete(projectRepositories).where(eq(projectRepositories.projectId, projectId)).run();
	for (const repositoryId of new Set(repositoryIds)) {
		const live = db
			.select({ id: repositories.id })
			.from(repositories)
			.where(and(eq(repositories.id, repositoryId), isNull(repositories.removedAt)))
			.get();
		if (live) db.insert(projectRepositories).values({ projectId, repositoryId }).run();
	}
	db.update(projects).set({ updatedAt: now }).where(eq(projects.id, projectId)).run();
	return findProject(db, projectId);
}
