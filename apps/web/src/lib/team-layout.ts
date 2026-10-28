/**
 * Where each member of a team goes in its drawing. Members go in rows, top-down from the lead:
 * each one row below the nearest member that reaches it, and members nothing reaches in a last
 * row. Edges are curves between them, apart when two members have more than one.
 */
import type { TeamEdge, TeamEdgeKind } from "@gateweave/agents-model";

export const NODE = { width: 176, height: 52 };
const GAP = { x: 24, y: 72 };
/** Room around the drawing, and below it for edges between members of the last row. */
const PADDING = { side: 16, top: 16, bottom: 48 };
/** How far apart the edges between the same two members run. */
const SPREAD = 12;
const ARROW = { length: 8, half: 4.5 };

export interface PlacedMember {
	x: number;
	y: number;
	row: number;
}

export interface PlacedEdge {
	from: string;
	to: string;
	kind: TeamEdgeKind;
	/** An SVG path, from the edge of one member's box to the other's. */
	path: string;
	/** The arrowhead at its end, as SVG polygon points. */
	arrow: string;
}

export interface TeamLayout {
	width: number;
	height: number;
	members: Map<string, PlacedMember>;
	edges: PlacedEdge[];
}

export function layoutTeam(
	members: { id: string; name: string }[],
	edges: TeamEdge[],
	leadId: string,
): TeamLayout {
	const names = new Map(members.map((member) => [member.id, member.name]));
	const rowOf = rows(
		members.map((member) => member.id),
		edges,
		leadId,
	);
	const byRow: string[][] = [];
	for (const [id, row] of rowOf) {
		const ids = byRow[row];
		if (ids) ids.push(id);
		else byRow[row] = [id];
	}

	// Each row in the order of the members that reach it, so edges cross less.
	const order = new Map<string, number>();
	for (const [row, ids] of byRow.entries()) {
		const weight = (id: string) => {
			const above = edges
				.filter((edge) => edge.to === id && (rowOf.get(edge.from) ?? row) < row)
				.map((edge) => order.get(edge.from) ?? 0);
			return above.length === 0 ? Number.POSITIVE_INFINITY : average(above);
		};
		ids.sort(
			(a, b) => weight(a) - weight(b) || (names.get(a) ?? "").localeCompare(names.get(b) ?? ""),
		);
		for (const [index, id] of ids.entries()) order.set(id, index);
	}

	const widest = Math.max(...byRow.map((ids) => ids.length), 1);
	const inner = widest * NODE.width + (widest - 1) * GAP.x;
	const placed = new Map<string, PlacedMember>();
	for (const [row, ids] of byRow.entries()) {
		const span = ids.length * NODE.width + (ids.length - 1) * GAP.x;
		for (const [index, id] of ids.entries()) {
			placed.set(id, {
				x: PADDING.side + (inner - span) / 2 + index * (NODE.width + GAP.x),
				y: PADDING.top + row * (NODE.height + GAP.y),
				row,
			});
		}
	}

	const between = new Map<string, TeamEdge[]>();
	for (const edge of edges) {
		const pair = [edge.from, edge.to].sort().join(" ");
		between.set(pair, [...(between.get(pair) ?? []), edge]);
	}
	const drawn: PlacedEdge[] = [];
	for (const group of between.values()) {
		for (const [index, edge] of group.entries()) {
			const from = placed.get(edge.from);
			const to = placed.get(edge.to);
			if (!from || !to) continue;
			const offset = (index - (group.length - 1) / 2) * SPREAD;
			drawn.push({ ...edge, ...curve(from, to, offset) });
		}
	}

	return {
		width: PADDING.side * 2 + inner,
		height: PADDING.top + byRow.length * NODE.height + (byRow.length - 1) * GAP.y + PADDING.bottom,
		members: placed,
		edges: drawn,
	};
}

/** Each member's row: how many edges away from the lead it is, or a last row for the rest. */
function rows(ids: string[], edges: TeamEdge[], leadId: string): Map<string, number> {
	const row = new Map<string, number>();
	if (ids.includes(leadId)) row.set(leadId, 0);
	for (let frontier = [leadId], depth = 1; frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const edge of edges) {
			if (frontier.includes(edge.from) && ids.includes(edge.to) && !row.has(edge.to)) {
				row.set(edge.to, depth);
				next.push(edge.to);
			}
		}
		frontier = next;
	}
	const last = row.size === 0 ? 0 : Math.max(...row.values()) + 1;
	for (const id of ids) if (!row.has(id)) row.set(id, last);
	return row;
}

/** A curve from one box to another: down, up, or out and back below a row. */
function curve(from: PlacedMember, to: PlacedMember, offset: number) {
	const startX = from.x + NODE.width / 2 + offset;
	const endX = to.x + NODE.width / 2 + offset;
	let start: [number, number];
	let end: [number, number];
	let bend: [number, number];
	if (to.row > from.row) {
		start = [startX, from.y + NODE.height];
		end = [endX, to.y];
		const reach = Math.max(24, (end[1] - start[1]) / 2);
		bend = [reach, -reach];
	} else if (to.row < from.row) {
		start = [startX, from.y];
		end = [endX, to.y + NODE.height];
		const reach = Math.max(24, (start[1] - end[1]) / 2);
		bend = [-reach, reach];
	} else {
		start = [startX, from.y + NODE.height];
		end = [endX, to.y + NODE.height];
		bend = [36, 36];
	}
	const control1: [number, number] = [start[0], start[1] + bend[0]];
	const control2: [number, number] = [end[0], end[1] + bend[1]];
	const path = `M ${point(start)} C ${point(control1)} ${point(control2)} ${point(end)}`;
	return { path, arrow: arrowhead(control2, end) };
}

/** A triangle at `tip`, pointing the way the curve arrives from `from`. */
function arrowhead(from: [number, number], tip: [number, number]): string {
	const dx = tip[0] - from[0];
	const dy = tip[1] - from[1];
	const length = Math.hypot(dx, dy) || 1;
	const [ux, uy] = [dx / length, dy / length];
	const base: [number, number] = [tip[0] - ux * ARROW.length, tip[1] - uy * ARROW.length];
	const left: [number, number] = [base[0] - uy * ARROW.half, base[1] + ux * ARROW.half];
	const right: [number, number] = [base[0] + uy * ARROW.half, base[1] - ux * ARROW.half];
	return [tip, left, right].map(point).join(" ");
}

const point = ([x, y]: [number, number]) => `${round(x)},${round(y)}`;
const round = (value: number) => Math.round(value * 10) / 10;
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
