import { MODEL_PROVIDER_NAMES } from "@gateweave/agents-model";
import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { type ChatAgent, startChat } from "#/lib/chat";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/chat/")({
	component: NewChat,
});

const layout = getRouteApi("/$workspace/chat");

/** Picks an agent to start a conversation with. */
function NewChat() {
	const data = layout.useLoaderData();
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Chat");
	const agents = data?.agents ?? [];

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
			<div className="mx-auto max-w-2xl space-y-6 px-4 py-10 sm:px-6">
				<div className="space-y-1">
					<h2 className="text-lg font-semibold tracking-tight">Start a conversation</h2>
					<p className="text-sm text-muted-foreground">
						Each agent answers with its own model and instructions, using the workspace's key for
						its provider.
					</p>
				</div>
				<ul className="divide-y rounded-lg border">
					{agents.map((agent) => (
						<AgentRow key={agent.id} agent={agent} />
					))}
				</ul>
			</div>
		</div>
	);
}

function AgentRow({ agent }: { agent: ChatAgent }) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const router = useRouter();
	const [pending, setPending] = useState(false);

	async function start() {
		setPending(true);
		try {
			const conversation = await startChat({ data: { slug, agentId: agent.id } });
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

	return (
		<li className="flex items-center justify-between gap-4 p-4">
			<div className="min-w-0 space-y-1">
				<p className="truncate text-sm font-medium">{agent.name}</p>
				<p className="truncate text-xs text-muted-foreground">
					{MODEL_PROVIDER_NAMES[agent.provider]} · <span className="font-mono">{agent.model}</span>
					{agent.keyed ? "" : ` · no ${MODEL_PROVIDER_NAMES[agent.provider]} key yet`}
				</p>
				{agent.description && (
					<p className="line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>
				)}
			</div>
			<Button size="sm" onClick={start} disabled={pending}>
				<MessagesSquare />
				Chat
			</Button>
		</li>
	);
}
