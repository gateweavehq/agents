import type { TeamDetail } from "@gateweave/agents-model";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { TeamGraph } from "#/components/registry/team-graph";
import { type ChatActivity, getChatActivity } from "#/lib/chat";
import { teamAtWork } from "#/lib/team-activity";

/** How often the panel asks who is at work, while anyone may be. */
const CHECK_EVERY_MS = 1500;

/**
 * The team a conversation is with, drawn as on its page, with the agents at work lit. It asks the
 * registry while a turn runs, and for as long as anyone is still at work after it, as after a
 * report.
 */
export function TeamPanel({
	slug,
	conversationId,
	detail,
	busy,
}: {
	slug: string;
	conversationId: string;
	detail: TeamDetail;
	busy: boolean;
}) {
	const [activity, setActivity] = useState<ChatActivity[]>([]);
	const watching = busy || activity.length > 0;
	const { members, agents } = useMemo(() => teamAtWork(detail, activity), [detail, activity]);

	useEffect(() => {
		let live = true;
		async function check() {
			try {
				const now = await getChatActivity({ data: { slug, conversationId } });
				if (live) setActivity(now ?? []);
			} catch {
				// The next check tries again, and the conversation says itself what went wrong.
			}
		}
		void check();
		if (!watching) {
			return () => {
				live = false;
			};
		}
		const timer = setInterval(check, CHECK_EVERY_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [slug, conversationId, watching]);

	return (
		<div className="space-y-4 p-4">
			<div className="space-y-1">
				<h2 className="text-sm font-medium">
					<Link
						to="/$workspace/teams/$teamId"
						params={{ workspace: slug, teamId: detail.team.id }}
						className="hover:underline"
					>
						{detail.team.name}
					</Link>
				</h2>
				{detail.team.description && (
					<p className="line-clamp-3 text-xs text-muted-foreground">{detail.team.description}</p>
				)}
			</div>
			<TeamGraph detail={detail} working={members} fit />
			<section aria-labelledby="at-work-heading" aria-live="polite" className="space-y-2">
				<h3 id="at-work-heading" className="text-xs font-medium text-muted-foreground">
					At work
				</h3>
				{agents.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nobody right now.</p>
				) : (
					<ul className="space-y-1 text-sm">
						{agents.map((agent) => (
							<li key={agent.runId}>
								<Link
									to="/$workspace/runs/$runId"
									params={{ workspace: slug, runId: agent.runId }}
									className="font-medium hover:underline"
								>
									{agent.name}
								</Link>
								{agent.within && <span className="text-muted-foreground"> in {agent.within}</span>}
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
