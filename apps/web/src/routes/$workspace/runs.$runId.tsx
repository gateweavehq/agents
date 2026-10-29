import { MODEL_PROVIDER_NAMES, type RunSpan, type TeamEdgeKind } from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { UIMessage } from "ai";
import { ChevronRight, GitPullRequestArrow, MessagesSquare, Webhook } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Transcript } from "#/components/chat/conversation-view";
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
	const { run, trace, nested, conversation, transcript } = data;

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-xl font-semibold tracking-tight">{run.agentName}</h1>
						<RunStatusBadge status={run.status} />
					</div>
					<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
						{run.triggerId !== null && <Webhook aria-hidden className="size-3.5 shrink-0" />}
						Started by {run.startedByName} on {formatDateTime(run.startedAt)}
					</p>
					{run.pullRequest && (
						<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
							<GitPullRequestArrow aria-hidden className="size-3.5 shrink-0" />
							Proposed its work in{" "}
							<a
								href={run.pullRequest.url}
								target="_blank"
								rel="noreferrer"
								className="font-medium text-foreground underline-offset-4 hover:underline"
							>
								{run.pullRequest.repository}#{run.pullRequest.number}
							</a>
						</p>
					)}
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
			{transcript !== null && (
				<TriggerTranscript transcript={transcript} run={run} nested={nested} />
			)}
		</div>
	);
}

/**
 * The conversation of a trigger's run: the message its delivery made and the agent's answer. No
 * person had it, so it is read here instead of in Chat.
 */
function TriggerTranscript({
	transcript,
	run,
	nested,
}: {
	transcript: string;
	run: RunEntry;
	nested: RunEntry[];
}) {
	// Our own server wrote it, from the conversation's stored messages.
	const messages = useMemo(() => JSON.parse(transcript) as UIMessage[], [transcript]);
	// The members its team's lead called, to show each call by the member it went to.
	const members = useMemo(
		() => (run.teamPath === null ? null : [...new Set(nested.map((each) => each.agentName))]),
		[run.teamPath, nested],
	);
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-medium">Conversation</h2>
			{messages.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					Nothing was said: the run ended before its first message was kept.
				</p>
			) : (
				<div className="rounded-lg border p-4">
					<Transcript messages={messages} agentName={run.agentName} members={members} />
				</div>
			)}
		</section>
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
						{span.error && <p className="break-words text-xs text-destructive">{span.error}</p>}
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
	const [failed, setFailed] = useState(false);
	const status = run?.status;
	const running = run?.total.running;

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetches again as the run goes on.
	useEffect(() => {
		if (!open) return;
		let live = true;
		getRun({ data: { slug, runId: id } })
			.then((fetched) => {
				if (!live) return;
				setDetail(fetched);
				setFailed(fetched === null);
			})
			.catch(() => {
				if (live) setFailed(true);
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
						{failed ? "Its trace could not be read." : "Loading its trace…"}
					</p>
				))}
		</div>
	);
}
