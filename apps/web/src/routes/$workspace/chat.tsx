import { createFileRoute, Link, Outlet, useParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "#/components/ui/button";
import { getChats } from "#/lib/chat";
import { formatRelative } from "#/lib/dates";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/$workspace/chat")({
	loader: ({ params }) => getChats({ data: params.workspace }),
	component: ChatLayout,
});

/** The caller's conversations beside the open one. On small screens, one or the other. */
function ChatLayout() {
	const data = Route.useLoaderData();
	const { workspace } = Route.useParams();
	const open = useParams({ strict: false, select: (params) => params.conversationId });
	const conversations = data?.conversations ?? [];

	return (
		<div className="flex h-full min-h-0">
			<aside
				aria-label="Conversations"
				className={cn(
					"w-full shrink-0 flex-col border-r md:flex md:w-72",
					open ? "hidden" : "flex",
				)}
			>
				<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
					<h1 className="text-sm font-medium">Chat</h1>
					<Button asChild size="sm" variant="ghost">
						<Link to="/$workspace/chat" params={{ workspace }}>
							<Plus />
							New
						</Link>
					</Button>
				</div>
				<nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
					{conversations.length === 0 ? (
						<p className="p-3 text-sm text-muted-foreground">
							Your conversations with agents appear here. Nobody else sees them.
						</p>
					) : (
						conversations.map((conversation) => (
							<Link
								key={conversation.id}
								to="/$workspace/chat/$conversationId"
								params={{ workspace, conversationId: conversation.id }}
								className="block rounded-md px-3 py-2 text-sm hover:bg-accent"
								activeProps={{ className: "bg-accent" }}
							>
								<span className="block truncate font-medium">
									{conversation.title ?? "New conversation"}
								</span>
								<span className="block truncate text-xs text-muted-foreground">
									{conversation.agentName}
									{conversation.agentRemoved ? " (removed)" : ""} ·{" "}
									{formatRelative(conversation.updatedAt)}
								</span>
							</Link>
						))
					)}
				</nav>
			</aside>
			<div className={cn("min-w-0 flex-1 flex-col md:flex", open ? "flex" : "hidden")}>
				<Outlet />
			</div>
		</div>
	);
}
