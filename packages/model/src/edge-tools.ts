import { TEAM_EDGE_KINDS, type TeamEdgeKind } from "./vocabulary";

/**
 * A team's edges are tools in a turn, named `delegate__<member>`, `ask__<member>` and
 * `report__<member>`. Providers take tool names of up to 64 letters, digits, `_` and `-`, so the
 * member's name is made to fit and cut to length. The registry gives a turn its edges sorted by
 * the member's name, and when two names come out the same, the second gets `_2`, and so on.
 */
export const EDGE_TOOL_NAME_LENGTH = 64;

/** The tool name of an edge to a member of this name, before it is cut to length or numbered. */
export function edgeToolName(kind: TeamEdgeKind, member: string): string {
	return `${kind}__${member.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Which of a team's members an edge tool went to, by its name; the kind of edge and the name as
 * the tool has it when none of them fits, and null for a tool that is no edge. The chat keeps
 * only the tool's name, so this is how it shows a call.
 */
export function readEdgeToolName(
	tool: string,
	members: readonly string[],
): { kind: TeamEdgeKind; member: string } | null {
	const kind = TEAM_EDGE_KINDS.find((each) => tool.startsWith(`${each}__`));
	if (!kind || tool.length === kind.length + 2) return null;
	const named = (name: string) => edgeToolName(kind, name).slice(0, EDGE_TOOL_NAME_LENGTH);
	const sorted = [...members].sort((a, b) => a.localeCompare(b));
	const exact = sorted.find((name) => named(name) === tool);
	if (exact) return { kind, member: exact };

	const numbered = /^(.+)_(\d+)$/.exec(tool);
	if (numbered?.[1] && numbered[2]) {
		const [, start, n] = numbered;
		// A numbered name was cut shorter to make room for its number when it was long.
		const cut = start.length === EDGE_TOOL_NAME_LENGTH - n.length - 1;
		const namesakes = sorted.filter((name) =>
			cut ? named(name).startsWith(start) : named(name) === start,
		);
		const member = namesakes[Number(n) - 1] ?? namesakes[0];
		if (member) return { kind, member };
	}
	return { kind, member: tool.slice(kind.length + 2) };
}
