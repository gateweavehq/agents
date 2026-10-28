import { MODEL_PROVIDER_NAMES } from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConversationView } from "#/components/chat/conversation-view";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { getChat, removeChat } from "#/lib/chat";
import { useDocumentTitle } from "#/lib/title";

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
	useDocumentTitle(data?.conversation.title ?? "Chat");

	if (!data) {
		return <Notice title="Conversation not found">It may have been deleted.</Notice>;
	}
	const { conversation, agent } = data;
	const provider = agent && MODEL_PROVIDER_NAMES[agent.provider];
	const blocked = !agent
		? "This agent was removed, so the conversation cannot go on."
		: !agent.keyed
			? `The workspace has no ${provider} key, so ${agent.name} cannot answer yet.${admin ? "" : " An owner or admin can add one in Settings."}`
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
						{agent ? (
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
				<RemoveButton conversationId={conversation.id} />
			</header>
			{blocked && (
				<p className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
					{blocked}
					{admin && agent && !agent.keyed && (
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
			{mounted ? (
				<Suspense fallback={<Loading />}>
					<ConversationView
						key={conversation.id}
						slug={slug}
						conversationId={conversation.id}
						agentName={agent?.name ?? conversation.agentName}
						disabled={blocked !== null}
						// The list shows the title the first message gave it, and the latest first.
						onTurnEnd={() => router.invalidate()}
					/>
				</Suspense>
			) : (
				<Loading />
			)}
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
