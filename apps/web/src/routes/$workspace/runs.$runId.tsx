import { MODEL_PROVIDER_NAMES, type RunSpan, type TeamEdgeKind } from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { RunStatusBadge, runDuration, TotalCost, tokensUsed } from "#/components/runs/run-labels";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime } from "#/lib/dates";
import { useRefreshWhile } from "#/lib/refresh";
import { getRun, type RunEntry } from "#/lib/runs";
import { useDocumentTitle } from "#/lib/title";
import { formatBytes, formatCost, formatDuration, formatTokens } from "#/lib/usage";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/$workspace/runs/$runId")({
	loader: ({ params }) => getRun({ data: { slug: params.workspace, runId: params.runId } }),
	component: RunPage,
});

function RunPage() {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	useDocumentTitle(data ? `Run of ${data.run.agentName}` : "Run");
	// Runs it led to may go on after it, as a report's does.
	useRefreshWhile(data?.run.status === "running" || (data?.run.total.running ?? 0) > 0);

	if (!data) return <Notice title="Run not found" />;
	const { run, trace, nested, conversation } = data;

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-xl font-semibold tracking-tight">{run.agentName}</h1>
						<RunStatusBadge status={run.status} />
					</div>
					<p className="text-sm text-muted-foreground">
						Started by {run.startedByName} on {formatDateTime(run.startedAt)}
					</p>
					{run.parentRunId && run.edge && (
						<p className="text-sm text-muted-foreground">
							{EDGE_REACHED[run.edge]}{" "}
							<Link
								to="/$workspace/runs/$runId"
								params={{ workspace: slug, runId: run.parentRunId }}
								className="underline underline-offset-4 hover:text-foreground"
							>
								another run
							</Link>{" "}
							in a team
						</p>
					)}
				</div>
				{conversation && (
					<Button asChild size="sm" variant="outline">
						<Link
							to="/$workspace/chat/$conversationId"
							params={{ workspace: slug, conversationId: conversation }}
						>
							<MessagesSquare />
							Open the conversation
						</Link>
					</Button>
				)}
			</header>
			{run.error && (
				<p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
					{run.error}
				</p>
			)}
			<Summary run={run} />
			{run.total.runs > 1 && (
				<p className="text-sm text-muted-foreground">
					With the {run.total.runs === 2 ? "run" : `${run.total.runs - 1} runs`} it led to over its
					team's edges: {tokensUsed(run.total)} ·{" "}
					<span className="text-foreground">
						<TotalCost total={run.total} />
					</span>
				</p>
			)}
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Trace</h2>
				<Trace run={run} trace={trace} nested={nested} />
			</section>
		</div>
	);
}

function Summary({ run }: { run: RunEntry }) {
	const items: { label: string; value: ReactNode }[] = [
		{ label: "Duration", value: runDuration(run) },
		{ label: "Model requests", value: run.steps },
		{
			label: "Input tokens",
			value: (
				<>
					{formatTokens(run.inputTokens)}
					{run.cachedInputTokens > 0 && (
						<span className="ml-1.5 text-xs font-normal text-muted-foreground">
							{formatTokens(run.cachedInputTokens)} cached
						</span>
					)}
				</>
			),
		},
		{ label: "Output tokens", value: formatTokens(run.outputTokens) },
		{
			label: "Estimated cost",
			value:
				run.cost === null ? (
					<span className="text-sm font-normal text-muted-foreground">
						No prices for this model
					</span>
				) : (
					formatCost(run.cost)
				),
		},
		{
			label: MODEL_PROVIDER_NAMES[run.provider],
			value: <span className="font-mono text-sm font-normal">{run.model}</span>,
		},
	];
	return (
		<dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
			{items.map(({ label, value }) => (
				<div key={label} className="min-w-0 rounded-lg border p-4">
					<dt className="text-xs text-muted-foreground">{label}</dt>
					<dd className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Why a model request ended, in words. */
const FINISH_REASONS: Record<string, string> = {
	stop: "Answered",
	"tool-calls": "Called tools",
	length: "Reached its output limit",
	"content-filter": "Stopped by the provider's filter",
	error: "Failed",
	other: "Stopped",
};

/** How a nested run was reached, before a link to the run that reached it. */
const EDGE_REACHED: Record<TeamEdgeKind, string> = {
	delegate: "Delegated to by",
	ask: "Asked by",
	report: "Reported to by",
};

/** What a call over an edge did, before the name of the member it went to. */
const EDGE_CALLS: Record<TeamEdgeKind, string> = {
	delegate: "Delegate to",
	ask: "Ask",
	report: "Report to",
};

const SPAN_COLORS: Record<RunSpan["status"], string> = {
	running: "bg-sky-500",
	ok: "bg-emerald-500",
	error: "bg-destructive",
};

function Trace({
	run,
	trace,
	nested,
}: {
	run: RunEntry;
	trace: RunSpan[] | null;
	nested: RunEntry[];
}) {
	if (trace === null) {
		return (
			<p className="text-sm text-muted-foreground">
				The conversation this run belonged to was deleted, and its trace with it.
			</p>
		);
	}
	if (trace.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">The run ended before it called the model.</p>
		);
	}
	return <Timeline run={run} trace={trace} nested={nested} />;
}

/**
 * Each span on one time axis, from the start of the run to its end: connecting to the agent's MCP
 * servers, each model request, and the tools each request called and the edges it took, under it.
 * Each edge it took shows the run it started, which opens to that run's own trace.
 */
function Timeline({ run, trace, nested }: { run: RunEntry; trace: RunSpan[]; nested: RunEntry[] }) {
	const end = Math.max(
		run.endedAt ?? (run.status === "running" ? Date.now() : run.startedAt),
		...trace.map((span) => span.endedAt ?? span.startedAt),
	);
	const total = Math.max(1, end - run.startedAt);
	const percent = (time: number) => ((time - run.startedAt) / total) * 100;

	return (
		<ol className="divide-y rounded-lg border">
			{trace.map((span) => {
				const spanEnd = span.endedAt ?? end;
				const { title, meta, details } = describeSpan(span, spanEnd);
				return (
					<li
						key={span.id}
						className={cn(
							"space-y-2 p-3",
							(span.kind === "tool" || span.kind === "edge") && "pl-8",
						)}
					>
						<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<span className="min-w-0 text-sm">{title}</span>
							<span className="text-xs text-muted-foreground tabular-nums">{meta}</span>
						</div>
						<div className="relative h-2 overflow-hidden rounded-full bg-muted">
							<div
								className={cn("absolute inset-y-0 rounded-full", SPAN_COLORS[span.status])}
								style={{
									left: `${percent(span.startedAt)}%`,
									width: `${Math.max(0.5, percent(spanEnd) - percent(span.startedAt))}%`,
								}}
							/>
						</div>
						{details.length > 0 && (
							<p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
								{details.map((detail, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of facts, in order
									<span key={index}>{detail}</span>
								))}
							</p>
						)}
						{span.error && <p className="text-xs text-destructive">{span.error}</p>}
						{span.kind === "edge" && span.childRunId && (
							<NestedRun
								id={span.childRunId}
								run={nested.find((each) => each.id === span.childRunId) ?? null}
							/>
						)}
					</li>
				);
			})}
		</ol>
	);
}

/** What a span's row says: its title, a line of numbers, and any facts below the bar. */
function describeSpan(
	span: RunSpan,
	spanEnd: number,
): { title: ReactNode; meta: string; details: ReactNode[] } {
	const duration = formatDuration(spanEnd - span.startedAt);
	switch (span.kind) {
		case "edge":
			return {
				title: (
					<>
						{EDGE_CALLS[span.edge]} <span className="font-medium">{span.to}</span>
					</>
				),
				meta: duration,
				// The run it started shows below, with its link.
				details: [],
			};
		case "connect":
			return {
				title: (
					<>
						Connect to <span className="font-medium">{span.server}</span>
					</>
				),
				// A server left out for a missing variable was never asked, so it took no time.
				meta:
					span.status === "error" && span.endedAt === span.startedAt
						? "Left out"
						: span.tools === null
							? duration
							: `${duration} · ${span.tools === 1 ? "1 tool" : `${span.tools} tools`}`,
				details: [],
			};
		case "tool":
			return {
				title: (
					<>
						{span.server}
						<span className="mx-1 text-muted-foreground">·</span>
						<span className="font-mono text-xs">{span.tool}</span>
					</>
				),
				meta: [
					duration,
					`${formatBytes(span.inputBytes)} in`,
					span.outputBytes !== null && `${formatBytes(span.outputBytes)} out`,
				]
					.filter(Boolean)
					.join(" · "),
				details: [],
			};
		case "model":
			return {
				title: (
					<>
						Model request {span.step + 1}
						<span className="ml-2 font-mono text-xs text-muted-foreground">{span.model}</span>
					</>
				),
				meta: [
					duration,
					`${formatTokens(span.inputTokens)} in`,
					`${formatTokens(span.outputTokens)} out`,
					span.cost !== null && formatCost(span.cost),
				]
					.filter(Boolean)
					.join(" · "),
				details: [
					span.firstTokenMs !== null && `First token after ${formatDuration(span.firstTokenMs)}`,
					span.finishReason && (FINISH_REASONS[span.finishReason] ?? span.finishReason),
					span.gatewayLogId && (
						<>
							AI Gateway log <span className="font-mono">{span.gatewayLogId}</span>
						</>
					),
				].filter(Boolean),
			};
	}
}

/**
 * A run an edge started, inside its caller's trace: what it did and used, all the runs under it
 * counted, and its own trace when opened, fetched then. A refresh of the page while it goes keeps
 * the open trace in step.
 */
function NestedRun({ id, run }: { id: string; run: RunEntry | null }) {
	const { slug } = useWorkspace();
	const [open, setOpen] = useState(false);
	const [detail, setDetail] = useState<Awaited<ReturnType<typeof getRun>>>(null);
	const [loading, setLoading] = useState(false);
	const status = run?.status;
	const running = run?.total.running;

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetches again as the run goes on.
	useEffect(() => {
		if (!open) return;
		let live = true;
		setLoading(true);
		getRun({ data: { slug, runId: id } })
			.then((fetched) => {
				if (live) setDetail(fetched);
			})
			.catch((error: unknown) => {
				if (live) toast.error(error instanceof Error ? error.message : "Something went wrong");
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [open, slug, id, status, running]);

	const link = (
		<Link
			to="/$workspace/runs/$runId"
			params={{ workspace: slug, runId: id }}
			className="underline underline-offset-4 hover:text-foreground"
		>
			Open its run
		</Link>
	);
	if (!run) return <p className="text-xs text-muted-foreground">{link}</p>;

	return (
		<div className="space-y-3 rounded-md border bg-muted/20 p-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-1.5"
					onClick={() => setOpen((shown) => !shown)}
					aria-expanded={open}
				>
					<ChevronRight className={cn("transition-transform", open && "rotate-90")} />
					<span className="font-medium">{run.agentName}</span>
				</Button>
				<RunStatusBadge status={run.status} />
				<span className="text-muted-foreground tabular-nums">
					{runDuration(run)} · {tokensUsed(run.total)}
					{run.total.runs > 1 && ` · with ${run.total.runs - 1} under it`}
				</span>
				<span className="tabular-nums">
					<TotalCost total={run.total} />
				</span>
				<span className="text-muted-foreground">{link}</span>
			</div>
			{open &&
				(detail ? (
					<Trace run={detail.run} trace={detail.trace} nested={detail.nested} />
				) : (
					<p className="px-1.5 text-xs text-muted-foreground">
						{loading ? "Loading its trace…" : "Its trace could not be read."}
					</p>
				))}
		</div>
	);
}
