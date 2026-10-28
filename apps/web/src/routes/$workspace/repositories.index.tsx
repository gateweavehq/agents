import { createFileRoute, Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { DriftBadge } from "#/components/registry/drift";
import { RuntimeBadge, ScanStatus } from "#/components/registry/labels";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useRefreshWhile } from "#/lib/refresh";
import { getRepositories } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/repositories/")({
	loader: ({ params }) => getRepositories({ data: params.workspace }),
	component: RepositoriesPage,
});

function RepositoriesPage() {
	const { slug } = useWorkspace();
	const repositories = Route.useLoaderData() ?? [];
	useDocumentTitle("Repositories");
	useRefreshWhile(repositories.some((repository) => repository.scanPending));

	if (repositories.length === 0) {
		return (
			<Notice title="No repositories yet">
				Repositories appear here once GitHub is connected in the workspace's settings.
			</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">Repositories</h1>
				<p className="text-sm text-muted-foreground">
					{repositories.length === 1 ? "1 repository" : `${repositories.length} repositories`} from
					GitHub, with the coding agents configured in each.
				</p>
			</header>
			<ul className="divide-y rounded-lg border">
				{repositories.map((repository) => (
					<li key={repository.id}>
						<Link
							to="/$workspace/repositories/$repositoryId"
							params={{ workspace: slug, repositoryId: repository.id }}
							className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 hover:bg-accent/50"
						>
							<span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
								<span className="truncate">
									<span className="text-muted-foreground">{repository.owner}/</span>
									{repository.name}
								</span>
								{repository.private && (
									<Lock aria-label="Private" className="size-3.5 shrink-0 text-muted-foreground" />
								)}
							</span>
							<span className="flex flex-wrap gap-1.5">
								{repository.runtimes.map((runtime) => (
									<RuntimeBadge key={runtime} runtime={runtime} />
								))}
								{repository.drift && <DriftBadge state={repository.drift} />}
							</span>
							<span className="w-32 text-right">
								<ScanStatus repository={repository} />
							</span>
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}
