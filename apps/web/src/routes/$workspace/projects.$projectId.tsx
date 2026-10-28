import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { FolderGit2, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AgentList } from "#/components/registry/agent-list";
import { ProjectDialog, RepositoriesDialog } from "#/components/registry/project-dialogs";
import { RuntimeMatrix } from "#/components/registry/runtime-matrix";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useRefreshWhile } from "#/lib/refresh";
import {
	deleteProject,
	getProject,
	getRepositories,
	setProjectRepositories,
	updateProject,
} from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/projects/$projectId")({
	loader: async ({ params }) => {
		const [detail, repositories] = await Promise.all([
			getProject({ data: { slug: params.workspace, projectId: params.projectId } }),
			getRepositories({ data: params.workspace }),
		]);
		return detail && { ...detail, allRepositories: repositories ?? [] };
	},
	component: ProjectPage,
});

function ProjectPage() {
	const data = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle(data ? data.project.name : "Project");
	useRefreshWhile(data?.repositories.some((repository) => repository.scanPending) ?? false);

	if (!data) {
		return <Notice title="Project not found">It may have been deleted.</Notice>;
	}
	const { project, repositories, agents } = data;

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
					{project.description && (
						<p className="text-sm whitespace-pre-line text-muted-foreground">
							{project.description}
						</p>
					)}
				</div>
				{admin && <ProjectActions />}
			</header>

			{repositories.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					No repositories in this project yet.
					{admin ? " Choose them with Repositories." : " An owner or admin can add them."}
				</p>
			) : (
				<RuntimeMatrix repositories={repositories} />
			)}

			{agents.length > 0 && (
				<section aria-labelledby="agents-heading" className="space-y-4">
					<h2 id="agents-heading" className="text-sm font-medium">
						Agents · {agents.length}
					</h2>
					<AgentList agents={agents} repositories={repositories} headingLevel="h3" />
				</section>
			)}
		</div>
	);
}

function ProjectActions() {
	const { slug } = useWorkspace();
	const router = useRouter();
	const navigate = useNavigate();
	const data = Route.useLoaderData();
	const [open, setOpen] = useState<"edit" | "repositories" | "delete" | null>(null);
	if (!data) return null;
	const { project } = data;
	const close = () => setOpen(null);

	return (
		<div className="flex shrink-0 gap-2">
			<Button variant="outline" size="sm" onClick={() => setOpen("repositories")}>
				<FolderGit2 />
				Repositories
			</Button>
			<Button variant="ghost" size="sm" onClick={() => setOpen("edit")}>
				<Pencil />
				Edit
			</Button>
			<Button variant="ghost" size="sm" onClick={() => setOpen("delete")}>
				<Trash2 />
				<span className="sr-only sm:not-sr-only">Delete</span>
			</Button>

			{open === "repositories" && (
				<RepositoriesDialog
					project={project}
					repositories={data.allRepositories}
					onSave={async (repositoryIds) => {
						await setProjectRepositories({
							data: { slug, projectId: project.id, repositoryIds },
						});
						await router.invalidate();
					}}
					onClose={close}
				/>
			)}
			{open === "edit" && (
				<ProjectDialog
					project={project}
					onSave={async (input) => {
						await updateProject({ data: { slug, projectId: project.id, project: input } });
						await router.invalidate();
					}}
					onClose={close}
				/>
			)}
			{open === "delete" && (
				<ConfirmDialog
					title={`Delete ${project.name}?`}
					confirmLabel="Delete project"
					onConfirm={async () => {
						try {
							await deleteProject({ data: { slug, projectId: project.id } });
						} catch (error) {
							toast.error("Could not delete the project", {
								description: error instanceof Error ? error.message : undefined,
							});
							return;
						}
						toast.success(`${project.name} was deleted`);
						await navigate({ to: "/$workspace/projects", params: { workspace: slug } });
					}}
					onClose={close}
				>
					Its repositories and their agents stay in the workspace; only the grouping goes.
				</ConfirmDialog>
			)}
		</div>
	);
}
