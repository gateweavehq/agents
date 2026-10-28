import { createFileRoute } from "@tanstack/react-router";
import { AgentList } from "#/components/registry/agent-list";
import { Notice } from "#/components/workspace/notice";
import { getAgents } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/agents")({
	loader: ({ params }) => getAgents({ data: params.workspace }),
	component: AgentsPage,
});

function AgentsPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("Agents");
	const agents = data?.agents ?? [];

	if (agents.length === 0) {
		return (
			<Notice title="No agents yet">
				Agents appear here once a connected repository has been scanned and agent configuration was
				found in it.
			</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">Agents</h1>
				<p className="text-sm text-muted-foreground">
					Every coding agent and subagent configured in this workspace's repositories.
				</p>
			</header>
			<AgentList agents={agents} repositories={data?.repositories ?? []} />
		</div>
	);
}
