import { isKeyedProvider, MODEL_PROVIDER_NAMES, providerMissing } from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Trash2, Users } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConversationView } from "#/components/chat/conversation-view";
import { TeamPanel } from "#/components/chat/team-panel";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { getChat, removeChat } from "#/lib/chat";
import { useDocumentTitle } from "#/lib/title";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/$workspace/chat/$conversationId")({
	loader: ({ params }) =>
		getChat({ data: { slug: params.workspace, conversationId: params.conversationId } }),
	component: ChatPage,
});

function ChatPage() {
	const data = Route.useLoaderData();
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	const router = useRouter();
	// The conversation talks over a WebSocket, which exists only in the browser.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	// Whether a turn runs, for the team beside the conversation to watch who is at work.
	const [busy, setBusy] = useState(false);
	// Narrower screens show the team over the conversation, when asked.
	const [showTeam, setShowTeam] = useState(false);
	const team = data?.team ?? null;
	const withTeam = data ? data.conversation.teamId !== null : false;
	// The names edge calls are shown by; a deleted team's calls keep the names the tools have.
	const members = useMemo(
		() => (withTeam ? (team?.members.map((member) => member.name) ?? []) : null),
		[withTeam, team],
	);
	useDocumentTitle(data?.conversation.title ?? "Chat");

	if (!data) {
		return <Notice title="Conversation not found">It may have been deleted.</Notice>;
	}
	const { conversation, agent } = data;
	const teamName = team?.team.name ?? conversation.teamName ?? "A deleted team";
	const provider = agent && MODEL_PROVIDER_NAMES[agent.provider];
	const blocked =
		withTeam && !team
			? "This team was deleted, so the conversation cannot go on."
			: withTeam && !agent
				? `The lead of ${teamName} was removed, so the team cannot answer. ${admin ? "Choose another lead on the team's page." : "An owner or admin can choose another on the team's page."}`
				: !agent
					? "This agent was removed, so the conversation cannot go on."
					: !agent.available
						? `${providerMissing(agent.provider)}, so ${agent.name} cannot answer yet.${isKeyedProvider(agent.provider) && !admin ? " An owner or admin can add one in Settings." : ""}`
						: null;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 sm:px-4">
				<Button asChild variant="ghost" size="icon" className="md:hidden">
					<Link to="/$workspace/chat" params={{ workspace: slug }} aria-label="All conversations">
						<ArrowLeft />
					</Link>
				</Button>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">{conversation.title ?? "New conversation"}</p>
					<p className="truncate text-xs text-muted-foreground">
						{withTeam ? (
							team ? (
								<>
									<Link
										to="/$workspace/teams/$teamId"
										params={{ workspace: slug, teamId: team.team.id }}
										className="hover:underline"
									>
										{team.team.name}
									</Link>
									{agent && (
										<>
											{" "}
											· led by{" "}
											<Link
												to="/$workspace/agents/$agentId"
												params={{ workspace: slug, agentId: agent.id }}
												className="hover:underline"
											>
												{agent.name}
											</Link>{" "}
											· <span className="font-mono">{agent.model}</span>
										</>
									)}
								</>
							) : (
								teamName
							)
						) : agent ? (
							<>
								<Link
									to="/$workspace/agents/$agentId"
									params={{ workspace: slug, agentId: agent.id }}
									className="hover:underline"
								>
									{agent.name}
								</Link>{" "}
								· {provider} · <span className="font-mono">{agent.model}</span>
							</>
						) : (
							`${conversation.agentName} (removed)`
						)}
					</p>
				</div>
				{team && (
					<Button
						variant="ghost"
						size="sm"
						className="2xl:hidden"
						onClick={() => setShowTeam((shown) => !shown)}
						aria-expanded={showTeam}
						aria-controls="team-panel"
					>
						<Users />
						<span className="sr-only sm:not-sr-only">Team</span>
					</Button>
				)}
				<RemoveButton conversationId={conversation.id} />
			</header>
			{blocked && (
				<p className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
					{blocked}
					{admin && agent && !agent.available && isKeyedProvider(agent.provider) && (
						<>
							{" "}
							<Link
								to="/$workspace/settings/models"
								params={{ workspace: slug }}
								className="underline underline-offset-2"
							>
								Add one in Settings
							</Link>
						</>
					)}
				</p>
			)}
			<div className="relative flex min-h-0 flex-1">
				<div className="flex min-w-0 flex-1 flex-col">
					{mounted ? (
						<Suspense fallback={<Loading />}>
							<ConversationView
								key={conversation.id}
								slug={slug}
								conversationId={conversation.id}
								agentName={withTeam ? teamName : (agent?.name ?? conversation.agentName)}
								members={members}
								disabled={blocked !== null}
								// The list shows the title the first message gave it, and the latest first.
								onTurnEnd={() => router.invalidate()}
								onBusyChange={setBusy}
							/>
						</Suspense>
					) : (
						<Loading />
					)}
				</div>
				{team && (
					<aside
						id="team-panel"
						aria-label="The team"
						className={cn(
							"overflow-y-auto border-l bg-background 2xl:static 2xl:block 2xl:w-[30rem] 2xl:shrink-0",
							showTeam ? "absolute inset-0 z-10 block sm:left-auto sm:w-[30rem]" : "hidden",
						)}
					>
						<TeamPanel slug={slug} conversationId={conversation.id} detail={team} busy={busy} />
					</aside>
				)}
			</div>
		</div>
	);
}

function Loading() {
	return <p className="flex-1 p-6 text-sm text-muted-foreground">Loading the conversation…</p>;
}

function RemoveButton({ conversationId }: { conversationId: string }) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const router = useRouter();
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
				<Trash2 />
				<span className="sr-only sm:not-sr-only">Delete</span>
			</Button>
			{open && (
				<ConfirmDialog
					title="Delete this conversation?"
					confirmLabel="Delete"
					onConfirm={async () => {
						try {
							await removeChat({ data: { slug, conversationId } });
						} catch (error) {
							toast.error(error instanceof Error ? error.message : "Something went wrong");
							return;
						}
						toast.success("The conversation was deleted");
						await navigate({ to: "/$workspace/chat", params: { workspace: slug } });
						await router.invalidate();
					}}
					onClose={() => setOpen(false)}
				>
					Its messages are deleted for good.
				</ConfirmDialog>
			)}
		</>
	);
}
