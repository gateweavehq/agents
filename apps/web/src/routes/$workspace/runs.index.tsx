import { createFileRoute, Link } from "@tanstack/react-router";
import { GitPullRequestArrow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RunStatusBadge, runDuration, TotalCost, tokensUsed } from "#/components/runs/run-labels";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { useRefreshWhile } from "#/lib/refresh";
import { getRuns, type RunEntry } from "#/lib/runs";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/runs/")({
	loader: ({ params }) => getRuns({ data: { slug: params.workspace } }),
	component: RunsPage,
});

function RunsPage() {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	// Pages after the first, as "Load more" fetches them.
	const [older, setOlder] = useState<{ runs: RunEntry[]; more: boolean } | null>(null);
	const [loading, setLoading] = useState(false);
	const first = data?.runs ?? [];
	const runs = older ? [...first, ...older.runs] : first;
	const more = older ? older.more : (data?.more ?? false);
	useDocumentTitle("Runs");
	// Refreshing would shift the first page away from the pages loaded after it.
	useRefreshWhile(
		older === null && first.some((run) => run.status === "running" || run.total.running > 0),
	);

	async function loadMore() {
		const last = runs.at(-1);
		if (!last) return;
		setLoading(true);
		try {
			const page = await getRuns({
				data: { slug, before: { startedAt: last.startedAt, id: last.id } },
			});
			if (page) setOlder({ runs: [...(older?.runs ?? []), ...page.runs], more: page.more });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong");
		} finally {
			setLoading(false);
		}
	}

	if (runs.length === 0) {
		return (
			<Notice
				title="No runs yet"
				action={
					<Button asChild size="sm" variant="outline">
						<Link to="/$workspace/chat" params={{ workspace: slug }}>
							Open Chat
						</Link>
					</Button>
				}
			>
				Each answer from an agent run by Gateweave is a run, with the time, tokens and estimated
				cost it took. A team's answer counts the runs it led to as well.
			</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">Runs</h1>
				<p className="text-sm text-muted-foreground">
					{data?.everyone
						? "Every answer from the agents run by Gateweave in this workspace, with what it used."
						: "The answers agents gave you, with what each one used."}{" "}
					A team's answer counts the runs it led to. Costs are estimates from the providers' list
					prices.
				</p>
			</header>
			<ul className="divide-y rounded-lg border">
				{runs.map((run) => (
					<li key={run.id}>
						<Link
							to="/$workspace/runs/$runId"
							params={{ workspace: slug, runId: run.id }}
							className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 hover:bg-accent/50"
						>
							<span className="w-24 shrink-0">
								<RunStatusBadge status={run.status} />
							</span>
							<span className="min-w-0 flex-1 text-sm">
								<span className="block truncate font-medium">
									{run.agentName}
									{run.total.runs > 1 && (
										<span className="font-normal text-muted-foreground">
											{" "}
											and {run.total.runs - 1} more
										</span>
									)}
								</span>
								<span className="block truncate text-xs text-muted-foreground">
									{data?.everyone && `${run.startedByName} · `}
									<span title={formatDateTime(run.startedAt)}>{formatRelative(run.startedAt)}</span>
									{run.pullRequest && (
										<>
											{" · "}
											<GitPullRequestArrow aria-hidden className="inline size-3 align-[-2px]" />{" "}
											{run.pullRequest.repository}#{run.pullRequest.number}
										</>
									)}
								</span>
							</span>
							<span className="text-xs text-muted-foreground tabular-nums">
								{runDuration(run)} · {tokensUsed(run.total)}
							</span>
							<span className="w-24 text-right text-sm tabular-nums">
								<TotalCost total={run.total} />
							</span>
						</Link>
					</li>
				))}
			</ul>
			{more && (
				<div className="flex justify-center">
					<Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
						{loading ? "Loading…" : "Load more"}
					</Button>
				</div>
			)}
		</div>
	);
}
