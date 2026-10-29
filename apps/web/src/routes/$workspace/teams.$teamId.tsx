import {
	type TeamDetail,
	type TeamEdge,
	type TeamGraphInput,
	type TeamMember,
	teamGraphInput,
} from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Bot, Crown, MessagesSquare, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AddEdgeDialog, AddMemberDialog, TeamDialog } from "#/components/registry/team-dialogs";
import { EDGE_STYLES, EDGE_VERBS, TeamGraph } from "#/components/registry/team-graph";
import { Triggers } from "#/components/registry/triggers";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { startTeamChat } from "#/lib/chat";
import { deleteTeam, getTeam, setTeamGraph, updateTeam } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";
import { getTriggers } from "#/lib/triggers";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/$workspace/teams/$teamId")({
	loader: async ({ params }) => {
		const [team, triggers] = await Promise.all([
			getTeam({ data: { slug: params.workspace, teamId: params.teamId } }),
			getTriggers({
				data: { slug: params.workspace, target: { kind: "team", teamId: params.teamId } },
			}),
		]);
		// Triggers are null for members: owners and admins manage them.
		return team && { ...team, triggers };
	},
	component: TeamPage,
});

/** The graph as it is saved, for a change to start from. */
function graphOf({ team, members, edges }: TeamDetail): TeamGraphInput {
	return {
		lead: team.leadAgentId,
		members: members.map((member) => ({ kind: member.kind, id: member.id })),
		edges,
	};
}

/** Saves a changed graph and reloads the page, or says why the registry refused it. */
function useSaveGraph() {
	const { slug } = useWorkspace();
	const router = useRouter();
	const data = Route.useLoaderData();
	return async (change: (graph: TeamGraphInput) => TeamGraphInput, done: string) => {
		if (!data) return;
		const parsed = teamGraphInput.safeParse(change(graphOf(data.detail)));
		if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "That does not fit");
		await setTeamGraph({ data: { slug, teamId: data.detail.team.id, graph: parsed.data } });
		toast.success(done);
		await router.invalidate();
	};
}

function TeamPage() {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle(data ? data.detail.team.name : "Team");

	if (!data) return <Notice title="Team not found">It may have been deleted.</Notice>;
	const { team, members, edges, partOf } = data.detail;
	const lead = members.find((member) => member.id === team.leadAgentId);

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-2">
					<h1 className="text-xl font-semibold tracking-tight">{team.name}</h1>
					{team.description && (
						<p className="text-sm whitespace-pre-line text-muted-foreground">{team.description}</p>
					)}
					{partOf.length > 0 && (
						<p className="text-sm text-muted-foreground">
							Part of{" "}
							{partOf.map((parent, index) => (
								<span key={parent.id}>
									{index > 0 && ", "}
									<Link
										to="/$workspace/teams/$teamId"
										params={{ workspace: slug, teamId: parent.id }}
										className="text-foreground hover:underline"
									>
										{parent.name}
									</Link>
								</span>
							))}
						</p>
					)}
				</div>
				<div className="flex shrink-0 flex-wrap gap-2">
					{lead?.kind === "agent" && !lead.removed && <ChatButton />}
					{admin && <TeamActions />}
				</div>
			</header>

			{lead?.kind === "agent" && lead.removed && (
				<p className="rounded-lg border border-amber-600/40 p-3 text-sm text-amber-700 dark:text-amber-500">
					Its lead, {lead.name}, was removed.{" "}
					{admin ? "Make another of its agents the lead." : "An owner or admin can choose another."}
				</p>
			)}

			<TeamGraph detail={data.detail} />

			<section aria-labelledby="members-heading" className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 id="members-heading" className="text-sm font-medium">
						Members · {members.length}
					</h2>
					{admin && <AddMemberButton />}
				</div>
				<ul className="divide-y rounded-lg border text-sm">
					{members.map((member) => (
						<MemberRow key={member.id} member={member} admin={admin} />
					))}
				</ul>
			</section>

			<section aria-labelledby="edges-heading" className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 id="edges-heading" className="text-sm font-medium">
						{edges.length === 0 ? "Edges" : `Edges · ${edges.length}`}
					</h2>
					{admin && members.length > 1 && <AddEdgeButton />}
				</div>
				{edges.length === 0 ? (
					<p className="rounded-lg border p-6 text-sm text-muted-foreground">
						No edges yet, so no member can reach another.
						{admin
							? members.length > 1
								? " Add one to let a member delegate to, ask or report to another."
								: " Add members first, then the edges between them."
							: " An owner or admin can add them."}
					</p>
				) : (
					<ul className="divide-y rounded-lg border text-sm">
						{sortedEdges(edges, members).map((edge) => (
							<EdgeRow key={`${edge.from} ${edge.to} ${edge.kind}`} edge={edge} admin={admin} />
						))}
					</ul>
				)}
			</section>

			{data.triggers && lead?.kind === "agent" && (
				<Triggers
					target={{ kind: "team", teamId: team.id }}
					targetName={team.name}
					triggers={data.triggers}
				/>
			)}
		</div>
	);
}

/** Edges by who they start from, then by kind and who they reach. */
function sortedEdges(edges: TeamEdge[], members: TeamMember[]) {
	const order = new Map(members.map((member, index) => [member.id, index]));
	const kinds = Object.keys(EDGE_VERBS);
	return [...edges].sort(
		(a, b) =>
			(order.get(a.from) ?? 0) - (order.get(b.from) ?? 0) ||
			kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
			(order.get(a.to) ?? 0) - (order.get(b.to) ?? 0),
	);
}

function MemberRow({ member, admin }: { member: TeamMember; admin: boolean }) {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	const save = useSaveGraph();
	const [pending, setPending] = useState(false);
	if (!data) return null;
	const isLead = member.id === data.detail.team.leadAgentId;
	const removed = member.kind === "agent" && member.removed;
	const Icon = member.kind === "agent" ? Bot : Users;

	async function run(action: () => Promise<void>) {
		setPending(true);
		try {
			await action();
		} catch (error) {
			toast.error("Could not change the team", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setPending(false);
		}
	}

	const makeLead = () =>
		run(() =>
			save((graph) => ({ ...graph, lead: member.id }), `${member.name} leads the team now`),
		);
	const takeOut = () =>
		run(() => {
			const dropped = data.detail.edges.filter(
				(edge) => edge.from === member.id || edge.to === member.id,
			).length;
			return save(
				(graph) => ({
					...graph,
					members: graph.members.filter((other) => other.id !== member.id),
					edges: graph.edges.filter((edge) => edge.from !== member.id && edge.to !== member.id),
				}),
				dropped === 0
					? `${member.name} was taken out`
					: `${member.name} was taken out, with ${dropped === 1 ? "its edge" : `its ${dropped} edges`}`,
			);
		});

	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
			<Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1">
				{removed ? (
					<span className="text-muted-foreground line-through">{member.name}</span>
				) : member.kind === "agent" ? (
					<Link
						to="/$workspace/agents/$agentId"
						params={{ workspace: slug, agentId: member.id }}
						className="font-medium hover:underline"
					>
						{member.name}
					</Link>
				) : (
					<Link
						to="/$workspace/teams/$teamId"
						params={{ workspace: slug, teamId: member.id }}
						className="font-medium hover:underline"
					>
						{member.name}
					</Link>
				)}
				<span className="block text-xs text-muted-foreground">
					{member.kind === "agent"
						? removed
							? "Removed agent"
							: `Agent · ${member.model}`
						: `Team led by ${member.lead.name} · ${member.members === 1 ? "1 member" : `${member.members} members`}`}
				</span>
			</span>
			{isLead && (
				<span className="inline-flex items-center gap-1 rounded-md border border-primary/40 px-1.5 py-0.5 text-xs">
					<Crown aria-hidden="true" className="size-3" />
					Lead
				</span>
			)}
			{admin && !isLead && (
				<span className="flex gap-1">
					{member.kind === "agent" && !removed && (
						<Button variant="ghost" size="sm" onClick={makeLead} disabled={pending}>
							Make lead
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={takeOut}
						disabled={pending}
						aria-label={`Take ${member.name} out of the team`}
						title="Take out of the team"
					>
						<X />
					</Button>
				</span>
			)}
		</li>
	);
}

function EdgeRow({ edge, admin }: { edge: TeamEdge; admin: boolean }) {
	const data = Route.useLoaderData();
	const save = useSaveGraph();
	const [pending, setPending] = useState(false);
	if (!data) return null;
	const name = (id: string) => data.detail.members.find((member) => member.id === id)?.name ?? "?";
	const sentence = `${name(edge.from)} ${EDGE_VERBS[edge.kind]} ${name(edge.to)}`;

	async function remove() {
		setPending(true);
		try {
			await save(
				(graph) => ({
					...graph,
					edges: graph.edges.filter(
						(other) => other.from !== edge.from || other.to !== edge.to || other.kind !== edge.kind,
					),
				}),
				"The edge was removed",
			);
		} catch (error) {
			toast.error("Could not remove the edge", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setPending(false);
		}
	}

	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
			<span className="min-w-0 flex-1">
				{name(edge.from)}{" "}
				<span className={cn("font-medium", EDGE_STYLES[edge.kind].className)}>
					{EDGE_VERBS[edge.kind]}
				</span>{" "}
				{name(edge.to)}
			</span>
			{admin && (
				<Button
					variant="ghost"
					size="sm"
					onClick={remove}
					disabled={pending}
					aria-label={`Remove: ${sentence}`}
					title="Remove the edge"
				>
					<X />
				</Button>
			)}
		</li>
	);
}

function AddMemberButton() {
	const data = Route.useLoaderData();
	const save = useSaveGraph();
	const [open, setOpen] = useState(false);
	if (!data) return null;
	const { detail } = data;
	const inTeam = new Set(detail.members.map((member) => member.id));

	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				<Plus />
				Add member
			</Button>
			{open && (
				<AddMemberDialog
					agents={data.agents.filter((agent) => !inTeam.has(agent.id))}
					teams={data.teams.filter(
						({ team }) => team.id !== detail.team.id && !inTeam.has(team.id),
					)}
					onAdd={(member) => {
						const name =
							member.kind === "agent"
								? data.agents.find((agent) => agent.id === member.id)?.name
								: data.teams.find(({ team }) => team.id === member.id)?.team.name;
						return save(
							(graph) => ({ ...graph, members: [...graph.members, member] }),
							`${name} joined the team`,
						);
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function AddEdgeButton() {
	const data = Route.useLoaderData();
	const save = useSaveGraph();
	const [open, setOpen] = useState(false);
	if (!data) return null;
	const { members, edges } = data.detail;
	const name = (id: string) => members.find((member) => member.id === id)?.name;

	return (
		<>
			<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
				<Plus />
				Add edge
			</Button>
			{open && (
				<AddEdgeDialog
					members={members}
					edges={edges}
					onAdd={(edge) =>
						save(
							(graph) => ({ ...graph, edges: [...graph.edges, edge] }),
							`${name(edge.from)} ${EDGE_VERBS[edge.kind]} ${name(edge.to)} now`,
						)
					}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

/** Starts a conversation with the team, which its lead answers. */
function ChatButton() {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const data = Route.useLoaderData();
	const [pending, setPending] = useState(false);
	if (!data) return null;
	const teamId = data.detail.team.id;

	async function start() {
		setPending(true);
		try {
			const conversation = await startTeamChat({ data: { slug, teamId } });
			await navigate({
				to: "/$workspace/chat/$conversationId",
				params: { workspace: slug, conversationId: conversation.id },
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong");
			setPending(false);
		}
	}

	return (
		<Button size="sm" onClick={start} disabled={pending}>
			<MessagesSquare />
			Chat
		</Button>
	);
}

function TeamActions() {
	const { slug } = useWorkspace();
	const router = useRouter();
	const navigate = useNavigate();
	const data = Route.useLoaderData();
	const [open, setOpen] = useState<"edit" | "delete" | null>(null);
	if (!data) return null;
	const { team, partOf } = data.detail;
	const close = () => setOpen(null);

	return (
		<div className="flex shrink-0 flex-wrap gap-2">
			<Button variant="ghost" size="sm" onClick={() => setOpen("edit")}>
				<Pencil />
				Edit
			</Button>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen("delete")}
				disabled={partOf.length > 0}
				title={partOf.length > 0 ? "Take it out of the teams it is in first" : undefined}
			>
				<Trash2 />
				<span className="sr-only sm:not-sr-only">Delete</span>
			</Button>

			{open === "edit" && (
				<TeamDialog
					team={team}
					onSave={async ({ name, description }) => {
						await updateTeam({ data: { slug, teamId: team.id, team: { name, description } } });
						toast.success("The team was saved");
						await router.invalidate();
					}}
					onClose={close}
				/>
			)}
			{open === "delete" && (
				<ConfirmDialog
					title={`Delete ${team.name}?`}
					confirmLabel="Delete team"
					onConfirm={async () => {
						try {
							await deleteTeam({ data: { slug, teamId: team.id } });
							toast.success(`${team.name} was deleted`);
							await navigate({ to: "/$workspace/teams", params: { workspace: slug } });
						} catch (error) {
							toast.error("Could not delete the team", {
								description: error instanceof Error ? error.message : undefined,
							});
						}
					}}
					onClose={close}
				>
					Its members and edges go with it. The agents in it stay as they are.
				</ConfirmDialog>
			)}
		</div>
	);
}
