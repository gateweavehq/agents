import type { TeamDetail } from "@gateweave/agents-model";
import type { ChatActivity } from "./chat";

/** An agent at work in a conversation with a team, and the member team it works inside, if any. */
export interface AtWork {
	runId: string;
	name: string;
	within: string | null;
}

/**
 * Who is at work in a conversation with a team, as the team's drawing shows it. An agent acting in
 * the team itself lights its own box; one acting deeper, inside a team that is a member, lights
 * that team's box, since the drawing shows the team as one member.
 */
export function teamAtWork(
	detail: TeamDetail,
	activity: readonly ChatActivity[],
): { members: Set<string>; agents: AtWork[] } {
	const names = new Map(detail.members.map((member) => [member.id, member.name]));
	const members = new Set<string>();
	const agents: AtWork[] = [];
	for (const run of activity) {
		const [top, inner] = run.teamPath ?? [];
		if (top !== detail.team.id) continue;
		const box = inner ?? run.agentId;
		if (!names.has(box)) continue;
		members.add(box);
		agents.push({
			runId: run.id,
			name: run.agentName,
			within: inner ? (names.get(inner) ?? null) : null,
		});
	}
	return { members, agents };
}
