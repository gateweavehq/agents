/**
 * Teams of agents run by Gateweave. A team is a directed graph: its members are agents or other
 * teams, and each edge lets one member delegate to, ask, or report to another. A member that is a
 * team stands for its lead.
 *
 * Two rules keep every turn of a team finite. A change to a graph is checked against both, in the
 * team itself and in every team it is part of:
 * - a team never contains itself, directly or through the teams in it;
 * - delegate and ask edges, the ones that wait for an answer, never go in a circle once the teams
 *   in it stand for their leads, so a turn can never end up waiting on itself.
 */
import type {
	newTeamInput,
	Team,
	TeamDetail,
	TeamEdgeKind,
	TeamEntry,
	TeamMember,
	TeamMemberKind,
	teamGraphInput,
	teamInput,
} from "@gateweave/agents-model";
import { and, asc, count, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import { agentDefinitions, agents, teamEdges, teamMembers, teams } from "./db/schema";
import type { Db } from "./state";

/** A change to a team that is refused, with a message fit to show the person who asked. */
export class TeamError extends Error {}

type Graph = z.output<typeof teamGraphInput>;

interface StoredGraph {
	lead: string;
	members: { kind: TeamMemberKind; id: string }[];
	edges: { from: string; to: string; kind: TeamEdgeKind }[];
}

/** Edges that wait for an answer, which must never go in a circle. */
const WAITING: ReadonlySet<TeamEdgeKind> = new Set(["delegate", "ask"]);

export function createTeam(db: Db, input: z.output<typeof newTeamInput>, now: number): Team {
	const lead = gateweaveAgents(db).get(input.lead);
	if (!lead) throw new TeamError("A team is led by an agent run by Gateweave");
	if (lead.removed) throw new TeamError(`${lead.name} was removed, so it cannot lead a team`);
	const { lead: leadAgentId, ...fields } = input;
	const row = { id: crypto.randomUUID(), ...fields, leadAgentId, createdAt: now, updatedAt: now };
	db.insert(teams).values(row).run();
	db.insert(teamMembers).values({ teamId: row.id, kind: "agent", memberId: leadAgentId }).run();
	return row;
}

export function updateTeam(
	db: Db,
	id: string,
	input: z.output<typeof teamInput>,
	now: number,
): Team | null {
	return (
		db
			.update(teams)
			.set({ ...input, updatedAt: now })
			.where(eq(teams.id, id))
			.returning()
			.get() ?? null
	);
}

/** A team in another team stays until it is taken out of there, so no graph loses a member. */
export function deleteTeam(db: Db, id: string): boolean {
	const team = db.select({ name: teams.name }).from(teams).where(eq(teams.id, id)).get();
	if (!team) return false;
	const parents = partOf(db, id);
	if (parents.length > 0) {
		throw new TeamError(
			`${team.name} is a member of ${parents.map((parent) => parent.name).join(", ")}. Take it out of there first`,
		);
	}
	db.delete(teamEdges).where(eq(teamEdges.teamId, id)).run();
	db.delete(teamMembers).where(eq(teamMembers.teamId, id)).run();
	db.delete(teams).where(eq(teams.id, id)).run();
	return true;
}

/**
 * Gives a team exactly these members and edges, and this lead. A removed agent can stay where it
 * was, so removing an agent never changes a graph by itself, but it cannot join anew or start
 * leading. Null when there is no such team.
 */
export function setTeamGraph(db: Db, teamId: string, graph: Graph, now: number): Team | null {
	const team = db.select().from(teams).where(eq(teams.id, teamId)).get();
	if (!team) return null;
	const agentsById = gateweaveAgents(db);
	const graphs = storedGraphs(db);
	const names = new Map<string, string>([
		...teamNames(db),
		...[...agentsById].map(([id, { name }]) => [id, name] as const),
	]);
	const current = new Set(graphs.get(teamId)?.members.map((member) => member.id));

	for (const member of graph.members) {
		if (member.kind === "agent") {
			const agent = agentsById.get(member.id);
			if (!agent) throw new TeamError("Only agents run by Gateweave can be in a team");
			if (agent.removed && !current.has(member.id)) {
				throw new TeamError(`${agent.name} was removed, so it cannot join a team`);
			}
		} else if (member.id === teamId) {
			throw new TeamError("A team cannot be a member of itself");
		} else if (!graphs.has(member.id)) {
			throw new TeamError("That team does not exist");
		}
	}
	const lead = agentsById.get(graph.lead);
	if (lead?.removed && graph.lead !== team.leadAgentId) {
		throw new TeamError(`${lead.name} was removed, so it cannot lead a team`);
	}

	graphs.set(teamId, graph);
	for (const member of graph.members) {
		if (member.kind === "team" && contains(graphs, member.id, teamId)) {
			const name = names.get(member.id);
			throw new TeamError(`${name} contains ${team.name}, so ${team.name} cannot contain ${name}`);
		}
	}
	for (const id of [teamId, ...teamsAbove(graphs, teamId)]) {
		const circle = waitingCircle(graphs, id);
		if (circle) {
			const where = id === teamId ? "" : ` in ${names.get(id)}`;
			throw new TeamError(
				`Delegate and ask edges would go in a circle${where}: ${circle.map((agent) => names.get(agent)).join(" → ")}`,
			);
		}
	}

	// Rows go in one at a time, since a Durable Object binds at most 100 parameters per query.
	db.delete(teamEdges).where(eq(teamEdges.teamId, teamId)).run();
	db.delete(teamMembers).where(eq(teamMembers.teamId, teamId)).run();
	for (const member of graph.members) {
		db.insert(teamMembers).values({ teamId, kind: member.kind, memberId: member.id }).run();
	}
	for (const edge of graph.edges) {
		db.insert(teamEdges)
			.values({ teamId, fromId: edge.from, toId: edge.to, kind: edge.kind })
			.run();
	}
	return (
		db
			.update(teams)
			.set({ leadAgentId: graph.lead, updatedAt: now })
			.where(eq(teams.id, teamId))
			.returning()
			.get() ?? null
	);
}

export function listTeams(db: Db): TeamEntry[] {
	const sizes = memberCounts(db);
	return db
		.select({ team: teams, leadName: agents.name, leadRemovedAt: agents.removedAt })
		.from(teams)
		.innerJoin(agents, eq(agents.id, teams.leadAgentId))
		.orderBy(asc(teams.name), asc(teams.createdAt))
		.all()
		.map(({ team, leadName, leadRemovedAt }) => ({
			team,
			lead: { id: team.leadAgentId, name: leadName, removed: leadRemovedAt !== null },
			members: sizes.get(team.id) ?? 0,
		}));
}

export function getTeam(db: Db, id: string): TeamDetail | null {
	const team = db.select().from(teams).where(eq(teams.id, id)).get();
	if (!team) return null;
	const agentMembers: TeamMember[] = db
		.select({
			id: agents.id,
			name: agents.name,
			removedAt: agents.removedAt,
			provider: agentDefinitions.provider,
			model: agentDefinitions.model,
		})
		.from(teamMembers)
		.innerJoin(agents, eq(agents.id, teamMembers.memberId))
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.where(and(eq(teamMembers.teamId, id), eq(teamMembers.kind, "agent")))
		.all()
		.map(({ removedAt, ...agent }) => ({
			kind: "agent" as const,
			...agent,
			removed: removedAt !== null,
		}));
	const nested = alias(teams, "nested");
	const sizes = memberCounts(db);
	const teamMembersOf: TeamMember[] = db
		.select({
			id: nested.id,
			name: nested.name,
			leadId: agents.id,
			leadName: agents.name,
		})
		.from(teamMembers)
		.innerJoin(nested, eq(nested.id, teamMembers.memberId))
		.innerJoin(agents, eq(agents.id, nested.leadAgentId))
		.where(and(eq(teamMembers.teamId, id), eq(teamMembers.kind, "team")))
		.all()
		.map(({ leadId, leadName, ...member }) => ({
			kind: "team" as const,
			...member,
			lead: { id: leadId, name: leadName },
			members: sizes.get(member.id) ?? 0,
		}));
	const members = [...agentMembers, ...teamMembersOf].sort(
		(a, b) =>
			Number(b.id === team.leadAgentId) - Number(a.id === team.leadAgentId) ||
			a.name.localeCompare(b.name),
	);
	const edges = db
		.select({ from: teamEdges.fromId, to: teamEdges.toId, kind: teamEdges.kind })
		.from(teamEdges)
		.where(eq(teamEdges.teamId, id))
		.all();
	return { team, members, edges, partOf: partOf(db, id) };
}

/** The teams `id` is a member of, by name. */
function partOf(db: Db, id: string): { id: string; name: string }[] {
	return db
		.select({ id: teams.id, name: teams.name })
		.from(teamMembers)
		.innerJoin(teams, eq(teams.id, teamMembers.teamId))
		.where(eq(teamMembers.memberId, id))
		.orderBy(asc(teams.name))
		.all();
}

/** Every agent run by Gateweave, removed ones too, by id. */
function gateweaveAgents(db: Db): Map<string, { name: string; removed: boolean }> {
	const rows = db
		.select({ id: agents.id, name: agents.name, removedAt: agents.removedAt })
		.from(agents)
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.all();
	return new Map(rows.map((row) => [row.id, { name: row.name, removed: row.removedAt !== null }]));
}

function teamNames(db: Db): Map<string, string> {
	const rows = db.select({ id: teams.id, name: teams.name }).from(teams).all();
	return new Map(rows.map((row) => [row.id, row.name]));
}

function memberCounts(db: Db): Map<string, number> {
	const rows = db
		.select({ teamId: teamMembers.teamId, members: count() })
		.from(teamMembers)
		.groupBy(teamMembers.teamId)
		.all();
	return new Map(rows.map((row) => [row.teamId, row.members]));
}

/** Every team's graph as stored, by id. A workspace has few teams, so they are read whole. */
function storedGraphs(db: Db): Map<string, StoredGraph> {
	const graphs = new Map<string, StoredGraph>(
		db
			.select({ id: teams.id, lead: teams.leadAgentId })
			.from(teams)
			.all()
			.map(({ id, lead }) => [id, { lead, members: [], edges: [] }]),
	);
	for (const row of db.select().from(teamMembers).all()) {
		graphs.get(row.teamId)?.members.push({ kind: row.kind, id: row.memberId });
	}
	for (const row of db.select().from(teamEdges).all()) {
		graphs.get(row.teamId)?.edges.push({ from: row.fromId, to: row.toId, kind: row.kind });
	}
	return graphs;
}

/** Whether `teamId` is `from`, or a member of it, or of a team in it, however deep. */
function contains(graphs: Map<string, StoredGraph>, from: string, teamId: string): boolean {
	const seen = new Set<string>();
	const pending = [from];
	for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
		if (id === teamId) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const member of graphs.get(id)?.members ?? []) {
			if (member.kind === "team") pending.push(member.id);
		}
	}
	return false;
}

/** The teams that contain `teamId`, however deep. */
function teamsAbove(graphs: Map<string, StoredGraph>, teamId: string): string[] {
	const parents = new Map<string, string[]>();
	for (const [id, graph] of graphs) {
		for (const member of graph.members) {
			if (member.kind === "team") parents.set(member.id, [...(parents.get(member.id) ?? []), id]);
		}
	}
	const above = new Set<string>();
	const pending = [teamId];
	for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
		for (const parent of parents.get(id) ?? []) {
			if (!above.has(parent)) {
				above.add(parent);
				pending.push(parent);
			}
		}
	}
	return [...above];
}

/**
 * A circle of waiting edges in the team and the teams in it, with every team standing for its
 * lead, as the agents along it with the first one again at the end. Null when there is none.
 */
function waitingCircle(graphs: Map<string, StoredGraph>, teamId: string): string[] | null {
	const next = new Map<string, string[]>();
	const seen = new Set<string>();
	const pending = [teamId];
	for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
		const graph = graphs.get(id);
		if (seen.has(id) || !graph) continue;
		seen.add(id);
		const standIn = new Map(
			graph.members.map((member) => [
				member.id,
				member.kind === "agent" ? member.id : graphs.get(member.id)?.lead,
			]),
		);
		for (const edge of graph.edges) {
			const from = standIn.get(edge.from);
			const to = standIn.get(edge.to);
			if (!WAITING.has(edge.kind) || from === undefined || to === undefined) continue;
			next.set(from, [...(next.get(from) ?? []), to]);
		}
		for (const member of graph.members) {
			if (member.kind === "team") pending.push(member.id);
		}
	}

	const done = new Set<string>();
	const path: string[] = [];
	const visit = (agent: string): string[] | null => {
		path.push(agent);
		for (const to of next.get(agent) ?? []) {
			const at = path.indexOf(to);
			if (at !== -1) return [...path.slice(at), to];
			if (!done.has(to)) {
				const circle = visit(to);
				if (circle) return circle;
			}
		}
		path.pop();
		done.add(agent);
		return null;
	};
	for (const agent of next.keys()) {
		const circle = done.has(agent) ? null : visit(agent);
		if (circle) return circle;
	}
	return null;
}
