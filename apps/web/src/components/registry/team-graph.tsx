import type { TeamDetail, TeamEdgeKind, TeamMember } from "@gateweave/agents-model";
import { Link } from "@tanstack/react-router";
import { Bot, Users } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "#/components/workspace/context";
import { layoutTeam, NODE } from "#/lib/team-layout";
import { cn } from "#/lib/utils";

/** Each kind of edge has its own color and dashes, so it reads without color too. */
export const EDGE_STYLES: Record<TeamEdgeKind, { className: string; dash?: string }> = {
	delegate: { className: "text-foreground/70" },
	ask: { className: "text-sky-600 dark:text-sky-400", dash: "6 4" },
	report: { className: "text-amber-600 dark:text-amber-500", dash: "1.5 4" },
};

export const EDGE_VERBS: Record<TeamEdgeKind, string> = {
	delegate: "delegates to",
	ask: "asks",
	report: "reports to",
};

/**
 * A team drawn top-down from its lead. The members are links; the edges are a picture of the list
 * the page shows next to it, so screen readers skip them. Members in `working` are lit, as a
 * conversation with the team shows who is at work. With `fit`, a drawing wider than its place
 * shrinks to fit it, as beside a conversation; otherwise it scrolls.
 */
export function TeamGraph({
	detail,
	working,
	fit = false,
}: {
	detail: TeamDetail;
	working?: ReadonlySet<string>;
	fit?: boolean;
}) {
	const { team, members, edges } = detail;
	const layout = useMemo(
		() => layoutTeam(members, edges, team.leadAgentId),
		[members, edges, team.leadAgentId],
	);
	const frame = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);

	useEffect(() => {
		const element = frame.current;
		if (!fit || !element) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setScale(Math.min(1, entry.contentRect.width / layout.width));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [fit, layout.width]);

	return (
		<figure className="space-y-2">
			<div ref={frame} className="overflow-x-auto rounded-lg border bg-muted/20">
				<div
					className="mx-auto"
					style={{ width: layout.width * scale, height: layout.height * scale }}
				>
					<div
						className="relative origin-top-left"
						style={{
							width: layout.width,
							height: layout.height,
							transform: scale < 1 ? `scale(${scale})` : undefined,
						}}
					>
						<svg
							aria-hidden="true"
							className="absolute inset-0"
							width={layout.width}
							height={layout.height}
						>
							{layout.edges.map((edge) => (
								<g
									key={`${edge.from} ${edge.to} ${edge.kind}`}
									className={EDGE_STYLES[edge.kind].className}
								>
									<path
										d={edge.path}
										fill="none"
										stroke="currentColor"
										strokeWidth={1.5}
										strokeDasharray={EDGE_STYLES[edge.kind].dash}
										strokeLinecap="round"
									/>
									<polygon points={edge.arrow} fill="currentColor" />
								</g>
							))}
						</svg>
						{members.map((member) => {
							const at = layout.members.get(member.id);
							if (!at) return null;
							return (
								<MemberBox
									key={member.id}
									member={member}
									lead={member.id === team.leadAgentId}
									working={working?.has(member.id) ?? false}
									style={{ left: at.x, top: at.y, width: NODE.width, height: NODE.height }}
								/>
							);
						})}
					</div>
				</div>
			</div>
			<figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{(Object.keys(EDGE_STYLES) as TeamEdgeKind[]).map((kind) => (
					<span key={kind} className="inline-flex items-center gap-1.5">
						<svg aria-hidden="true" width="24" height="8" className={EDGE_STYLES[kind].className}>
							<line
								x1="1"
								y1="4"
								x2="23"
								y2="4"
								stroke="currentColor"
								strokeWidth={1.5}
								strokeDasharray={EDGE_STYLES[kind].dash}
								strokeLinecap="round"
							/>
						</svg>
						{EDGE_VERBS[kind]}
					</span>
				))}
			</figcaption>
		</figure>
	);
}

function MemberBox({
	member,
	lead,
	working,
	style,
}: {
	member: TeamMember;
	lead: boolean;
	working: boolean;
	style: CSSProperties;
}) {
	const { slug } = useWorkspace();
	const removed = member.kind === "agent" && member.removed;
	const Icon = member.kind === "agent" ? Bot : Users;
	const className = cn(
		"absolute flex items-center gap-2 rounded-md border bg-background px-2.5 text-left shadow-xs",
		lead && "border-primary ring-1 ring-primary",
		working && "border-sky-500 ring-2 ring-sky-500/60",
		removed ? "border-dashed text-muted-foreground" : "hover:bg-accent",
	);
	const content = (
		<>
			<Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1">
				<span className={cn("block truncate text-sm font-medium", removed && "line-through")}>
					{member.name}
				</span>
				<span className="block truncate text-xs text-muted-foreground">
					{working ? (
						<span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400">
							<span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-current" />
							At work
						</span>
					) : removed ? (
						"Removed"
					) : member.kind === "agent" ? (
						lead ? (
							`Lead · ${member.model}`
						) : (
							member.model
						)
					) : (
						`Team led by ${member.lead.name}`
					)}
				</span>
			</span>
		</>
	);

	// A removed agent has no page to go to.
	if (removed) {
		return (
			<div className={className} style={style}>
				{content}
			</div>
		);
	}
	return member.kind === "agent" ? (
		<Link
			to="/$workspace/agents/$agentId"
			params={{ workspace: slug, agentId: member.id }}
			className={className}
			style={style}
		>
			{content}
		</Link>
	) : (
		<Link
			to="/$workspace/teams/$teamId"
			params={{ workspace: slug, teamId: member.id }}
			className={className}
			style={style}
		>
			{content}
		</Link>
	);
}
