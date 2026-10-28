import { MODEL_PROVIDER_NAMES, type RunSpan, type TeamEdgeKind } from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";
import { RunStatusBadge, runDuration } from "#/components/runs/run-labels";
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
	useRefreshWhile(data?.run.status === "running");

	if (!data) return <Notice title="Run not found" />;
	const { run, trace, conversation } = data;

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
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Trace</h2>
				{trace === null ? (
					<p className="text-sm text-muted-foreground">
						The conversation this run belonged to was deleted, and its trace with it.
					</p>
				) : trace.length === 0 ? (
					<p className="text-sm text-muted-foreground">The run ended before it called the model.</p>
				) : (
					<Timeline run={run} trace={trace} />
				)}
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

/**
 * Each span on one time axis, from the start of the run to its end: connecting to the agent's MCP
 * servers, each model request, and the tools each request called and the edges it took, under it.
 */
function Timeline({ run, trace }: { run: RunEntry; trace: RunSpan[] }) {
	const { slug } = useWorkspace();
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
				const { title, meta, details } = describeSpan(span, spanEnd, slug);
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
	slug: string,
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
				details: span.childRunId
					? [
							<Link
								key="run"
								to="/$workspace/runs/$runId"
								params={{ workspace: slug, runId: span.childRunId }}
								className="underline underline-offset-4 hover:text-foreground"
							>
								Open its run
							</Link>,
						]
					: [],
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
