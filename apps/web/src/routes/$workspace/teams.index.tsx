import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { TeamDialog } from "#/components/registry/team-dialogs";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { createTeam, getTeams } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/teams/")({
	loader: async ({ params }) =>
		(await getTeams({ data: params.workspace })) ?? { teams: [], agents: [] },
	component: TeamsPage,
});

function TeamsPage() {
	const { slug } = useWorkspace();
	const { teams } = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Teams");

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">Teams</h1>
					<p className="text-sm text-muted-foreground">
						Agents run by Gateweave working together: who leads, who is in each team, and who may
						delegate to, ask or report to whom.
					</p>
				</div>
				{admin && <NewTeamButton />}
			</header>
			{teams.length === 0 ? (
				<p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
					No teams yet. A team is led by an agent run by Gateweave, which hands work to the other
					members along the team's edges. Teams can be members of other teams.
					{admin ? "" : " An owner or admin can create one."}
				</p>
			) : (
				<ul className="divide-y rounded-lg border">
					{teams.map(({ team, lead, members }) => (
						<li key={team.id}>
							<Link
								to="/$workspace/teams/$teamId"
								params={{ workspace: slug, teamId: team.id }}
								className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 hover:bg-accent/50"
							>
								<span className="min-w-0 flex-1">
									<span className="text-sm font-medium">{team.name}</span>
									{team.description && (
										<span className="block truncate text-sm text-muted-foreground">
											{team.description}
										</span>
									)}
								</span>
								<span className="text-right text-xs">
									<span className="block text-muted-foreground">
										{members === 1 ? "1 member" : `${members} members`}
									</span>
									{lead.removed ? (
										<span className="block text-amber-600 dark:text-amber-500">
											Its lead was removed
										</span>
									) : (
										<span className="block text-muted-foreground">Led by {lead.name}</span>
									)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function NewTeamButton() {
	const { slug } = useWorkspace();
	const { agents } = Route.useLoaderData();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button
				size="sm"
				onClick={() => setOpen(true)}
				disabled={agents.length === 0}
				title={agents.length === 0 ? "Define an agent on the Agents page first" : undefined}
			>
				<Plus />
				New team
			</Button>
			{open && (
				<TeamDialog
					agents={agents}
					onSave={async (team) => {
						const created = await createTeam({ data: { slug, team } });
						toast.success(`${created.name} was created`);
						// Its page is where members and edges are chosen.
						await navigate({
							to: "/$workspace/teams/$teamId",
							params: { workspace: slug, teamId: created.id },
						});
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
