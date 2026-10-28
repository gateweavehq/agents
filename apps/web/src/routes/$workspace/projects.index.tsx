import { type AgentRuntime, REPOSITORY_RUNTIMES } from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RuntimeBadge } from "#/components/registry/labels";
import { ProjectDialog } from "#/components/registry/project-dialogs";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { createProject, getProjects } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/projects/")({
	loader: ({ params }) => getProjects({ data: params.workspace }),
	component: ProjectsPage,
});

function ProjectsPage() {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Projects");
	const projects = data?.projects ?? [];
	const runtimesOf = new Map(
		(data?.repositories ?? []).map((repository) => [repository.id, repository.runtimes]),
	);

	if (projects.length === 0) {
		return (
			<Notice title="No projects yet" action={admin ? <NewProjectButton /> : undefined}>
				A project groups the repositories of one product or initiative, so its page shows every
				agent working on it.{admin ? "" : " An owner or admin can create one."}
			</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">Projects</h1>
					<p className="text-sm text-muted-foreground">
						The products and initiatives of this workspace, with their repositories.
					</p>
				</div>
				{admin && <NewProjectButton />}
			</header>
			<ul className="divide-y rounded-lg border">
				{projects.map((project) => {
					// The coding agents found in any of the project's repositories.
					const runtimes = new Set<AgentRuntime>(
						project.repositoryIds.flatMap((id) => runtimesOf.get(id) ?? []),
					);
					const count = project.repositoryIds.length;
					return (
						<li key={project.id}>
							<Link
								to="/$workspace/projects/$projectId"
								params={{ workspace: slug, projectId: project.id }}
								className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 hover:bg-accent/50"
							>
								<span className="min-w-0 flex-1">
									<span className="text-sm font-medium">{project.name}</span>
									{project.description && (
										<span className="block truncate text-sm text-muted-foreground">
											{project.description}
										</span>
									)}
								</span>
								<span className="flex flex-wrap gap-1.5">
									{REPOSITORY_RUNTIMES.filter((runtime) => runtimes.has(runtime)).map((runtime) => (
										<RuntimeBadge key={runtime} runtime={runtime} />
									))}
								</span>
								<span className="w-28 text-right text-xs text-muted-foreground tabular-nums">
									{count === 1 ? "1 repository" : `${count} repositories`}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function NewProjectButton() {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<Plus />
				New project
			</Button>
			{open && (
				<ProjectDialog
					onSave={async (project) => {
						const created = await createProject({ data: { slug, project } });
						toast.success(`${created.name} was created`);
						// Its page is where repositories are chosen.
						await navigate({
							to: "/$workspace/projects/$projectId",
							params: { workspace: slug, projectId: created.id },
						});
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
