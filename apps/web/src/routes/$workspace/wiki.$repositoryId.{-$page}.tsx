import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Markdown } from "#/components/chat/markdown";
import { Button } from "#/components/ui/button";
import {
	StartWikiDialog,
	underway,
	WikiProvenance,
	WikiStatus,
} from "#/components/wiki/wiki-dialogs";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useRefreshWhile } from "#/lib/refresh";
import { useDocumentTitle } from "#/lib/title";
import { cn } from "#/lib/utils";
import { fileUrl, getWiki, linkCitations } from "#/lib/wiki";

// The page is a path segment, as on DeepWiki: a search parameter is read as JSON, which would
// make page "1.10" the number 1.1.
export const Route = createFileRoute("/$workspace/wiki/$repositoryId/{-$page}")({
	loader: ({ params }) =>
		getWiki({
			data: { slug: params.workspace, repositoryId: params.repositoryId, page: params.page },
		}),
	component: WikiPageView,
});

function WikiPageView() {
	const found = Route.useLoaderData();
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	const [writing, setWriting] = useState(false);
	useDocumentTitle(found?.page ? found.page.title : found ? `${found.wiki.name} wiki` : "Wiki");
	useRefreshWhile(underway(found?.wiki.latest ?? null), 5000);

	if (!found) {
		return (
			<Notice title="Repository not found">
				It may have left the workspace, or GitHub no longer gives the app access to it.
			</Notice>
		);
	}
	const { wiki, page } = found;
	return (
		<div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
			<header className="mb-6 flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<h1 className="truncate text-xl font-semibold tracking-tight">
						<span className="font-normal text-muted-foreground">{wiki.owner}/</span>
						{wiki.name}
					</h1>
					<p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
						{wiki.live && <WikiProvenance generation={wiki.live} />}
						{(!wiki.live || wiki.latest) && <WikiStatus entry={wiki} />}
					</p>
					{wiki.latest?.status === "failed" && wiki.latest.error && (
						<p className="text-xs text-destructive">{wiki.latest.error}</p>
					)}
					{wiki.live?.steeringProblem && (
						<p className="text-xs text-muted-foreground">{wiki.live.steeringProblem}</p>
					)}
				</div>
				<div className="flex shrink-0 gap-2">
					{admin && (
						<Button
							size="sm"
							variant="outline"
							disabled={underway(wiki.latest)}
							onClick={() => setWriting(true)}
						>
							{wiki.live ? "Write again" : "Write"}
						</Button>
					)}
					<Button asChild variant="ghost" size="sm">
						<Link to="/$workspace/wiki" params={{ workspace: slug }}>
							All wikis
						</Link>
					</Button>
				</div>
			</header>
			{wiki.pages.length === 0 ? (
				<Notice title="No wiki yet">
					{underway(wiki.latest)
						? "It is being written; the pages show here once every one is done."
						: "An owner or admin can have one written."}
				</Notice>
			) : (
				<div className="grid gap-8 md:grid-cols-[14rem_1fr]">
					<nav aria-label="Pages" className="md:sticky md:top-6 md:self-start">
						<ul className="space-y-0.5 text-sm">
							{wiki.pages.map((entry) => (
								<li key={entry.number}>
									<Link
										to="/$workspace/wiki/$repositoryId/{-$page}"
										params={{
											workspace: slug,
											repositoryId: wiki.repositoryId,
											page: entry.number,
										}}
										className={cn(
											"block truncate rounded px-2 py-1 hover:bg-accent/50",
											entry.depth > 0 && "pl-5 text-muted-foreground",
											page?.number === entry.number && "bg-accent font-medium text-foreground",
										)}
									>
										{entry.number} {entry.title}
									</Link>
								</li>
							))}
						</ul>
					</nav>
					{page ? (
						<article className="min-w-0 space-y-4">
							<h2 className="text-2xl font-semibold tracking-tight">{page.title}</h2>
							{page.sources.length > 0 && (
								<details className="rounded-md border px-3 py-2 text-sm">
									<summary className="cursor-pointer text-muted-foreground">
										Relevant source files ({page.sources.length})
									</summary>
									<ul className="mt-2 space-y-1">
										{page.sources.map((source) => (
											<li key={source.path}>
												<a
													href={fileUrl(wiki, page.commit, source.path)}
													target="_blank"
													rel="noopener noreferrer"
													className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
												>
													{source.path}
													<ExternalLink className="size-3" />
												</a>
											</li>
										))}
									</ul>
								</details>
							)}
							<div className="text-sm leading-relaxed">
								<Markdown>{linkCitations(page.body, wiki, page.commit)}</Markdown>
							</div>
						</article>
					) : (
						<Notice title="Page not found">This wiki has no such page.</Notice>
					)}
				</div>
			)}
			{writing && <StartWikiDialog slug={slug} entry={wiki} onClose={() => setWriting(false)} />}
		</div>
	);
}
