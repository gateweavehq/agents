import type { WikiEntry } from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { StartWikiDialog, underway, WikiStatus } from "#/components/wiki/wiki-dialogs";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useRefreshWhile } from "#/lib/refresh";
import { useDocumentTitle } from "#/lib/title";
import { getWikis } from "#/lib/wiki";

export const Route = createFileRoute("/$workspace/wiki/")({
	loader: ({ params }) => getWikis({ data: params.workspace }),
	component: WikisPage,
});

function WikisPage() {
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	const entries = Route.useLoaderData() ?? [];
	const [writing, setWriting] = useState<WikiEntry | null>(null);
	useDocumentTitle("Wiki");
	useRefreshWhile(
		entries.some((entry) => underway(entry.latest)),
		5000,
	);

	if (entries.length === 0) {
		return (
			<Notice title="No repositories yet">
				Each repository can have a wiki written about its code. Repositories appear here once GitHub
				or GitLab is connected in the workspace's settings.
			</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">Wiki</h1>
				<p className="text-sm text-muted-foreground">
					Pages a model writes about each repository's code, citing the lines they explain. AI
					agents read them over MCP with the tools DeepWiki has, at this server's /mcp.
				</p>
			</header>
			<ul className="divide-y rounded-lg border">
				{entries.map((entry) => (
					<li key={entry.repositoryId} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
						<span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
							{entry.live ? (
								<Link
									to="/$workspace/wiki/$repositoryId/{-$page}"
									params={{ workspace: slug, repositoryId: entry.repositoryId }}
									className="truncate hover:underline"
								>
									<span className="text-muted-foreground">{entry.owner}/</span>
									{entry.name}
								</Link>
							) : (
								<span className="truncate">
									<span className="text-muted-foreground">{entry.owner}/</span>
									{entry.name}
								</span>
							)}
							{entry.private && (
								<Lock aria-label="Private" className="size-3.5 shrink-0 text-muted-foreground" />
							)}
						</span>
						<WikiStatus entry={entry} />
						{admin && (
							<Button
								size="sm"
								variant="outline"
								disabled={underway(entry.latest)}
								onClick={() => setWriting(entry)}
							>
								{entry.live ? "Write again" : "Write"}
							</Button>
						)}
					</li>
				))}
			</ul>
			{writing && <StartWikiDialog slug={slug} entry={writing} onClose={() => setWriting(null)} />}
		</div>
	);
}
