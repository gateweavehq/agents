import { MODEL_PROVIDER_NAMES, providerMissingShort } from "@gateweave/agents-model";
import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { type ChatAgent, type ChatTeam, startChat, startTeamChat } from "#/lib/chat";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/chat/")({
	component: NewChat,
});

const layout = getRouteApi("/$workspace/chat");

/** Picks an agent or a team to start a conversation with. */
function NewChat() {
	const data = layout.useLoaderData();
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Chat");
	const agents = data?.agents ?? [];
	const teams = data?.teams ?? [];

	if (agents.length === 0) {
		return (
			<Notice
				title="No agent to talk to yet"
				action={
					<Button asChild size="sm" variant="outline">
						<Link to="/$workspace/agents" params={{ workspace: slug }}>
							Go to Agents
						</Link>
					</Button>
				}
			>
				{admin
					? "Define an agent run by Gateweave on the Agents page, and chat with it here."
					: "An owner or admin defines agents run by Gateweave on the Agents page."}
			</Notice>
		);
	}

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-2xl space-y-8 px-4 py-10 sm:px-6">
				<div className="space-y-1">
					<h2 className="text-lg font-semibold tracking-tight">Start a conversation</h2>
					<p className="text-sm text-muted-foreground">
						Each agent answers with its own model and instructions, using the workspace's key for
						its provider. A team's lead answers for the team, and hands work to the others over the
						team's edges.
					</p>
				</div>
				<section aria-labelledby="agents-heading" className="space-y-3">
					<h3 id="agents-heading" className="text-sm font-medium">
						Agents
					</h3>
					<ul className="divide-y rounded-lg border">
						{agents.map((agent) => (
							<AgentRow key={agent.id} agent={agent} />
						))}
					</ul>
				</section>
				{teams.length > 0 && (
					<section aria-labelledby="teams-heading" className="space-y-3">
						<h3 id="teams-heading" className="text-sm font-medium">
							Teams
						</h3>
						<ul className="divide-y rounded-lg border">
							{teams.map((team) => (
								<TeamRow key={team.id} team={team} />
							))}
						</ul>
					</section>
				)}
			</div>
		</div>
	);
}

/** Starts a conversation and opens it, or says why it could not. */
function useStart(start: (slug: string) => Promise<{ id: string }>) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const router = useRouter();
	const [pending, setPending] = useState(false);

	async function run() {
		setPending(true);
		try {
			const conversation = await start(slug);
			await navigate({
				to: "/$workspace/chat/$conversationId",
				params: { workspace: slug, conversationId: conversation.id },
			});
			// The list beside it shows the new conversation.
			await router.invalidate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong");
			setPending(false);
		}
	}
	return { run, pending };
}

function AgentRow({ agent }: { agent: ChatAgent }) {
	const { run, pending } = useStart((slug) => startChat({ data: { slug, agentId: agent.id } }));

	return (
		<li className="flex items-center justify-between gap-4 p-4">
			<div className="min-w-0 space-y-1">
				<p className="truncate text-sm font-medium">{agent.name}</p>
				<p className="truncate text-xs text-muted-foreground">
					{MODEL_PROVIDER_NAMES[agent.provider]} · <span className="font-mono">{agent.model}</span>
					{agent.available ? "" : ` · ${providerMissingShort(agent.provider)}`}
				</p>
				{agent.description && (
					<p className="line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>
				)}
			</div>
			<Button size="sm" onClick={run} disabled={pending}>
				<MessagesSquare />
				Chat
			</Button>
		</li>
	);
}

function TeamRow({ team }: { team: ChatTeam }) {
	const { run, pending } = useStart((slug) => startTeamChat({ data: { slug, teamId: team.id } }));
	const { lead } = team;

	return (
		<li className="flex items-center justify-between gap-4 p-4">
			<div className="min-w-0 space-y-1">
				<p className="truncate text-sm font-medium">{team.name}</p>
				<p className="truncate text-xs text-muted-foreground">
					{lead ? `Led by ${lead.name}` : `Its lead, ${team.leadName}, was removed`} ·{" "}
					{team.members === 1 ? "1 member" : `${team.members} members`}
					{lead && !lead.available ? ` · ${providerMissingShort(lead.provider)}` : ""}
				</p>
				{team.description && (
					<p className="line-clamp-2 text-sm text-muted-foreground">{team.description}</p>
				)}
			</div>
			<Button size="sm" onClick={run} disabled={pending || !lead}>
				<MessagesSquare />
				Chat
			</Button>
		</li>
	);
}
