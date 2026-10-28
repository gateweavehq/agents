import { AGENT_RUNTIMES, type Agent, RUNTIME_NAMES } from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RuntimeBadge } from "#/components/registry/labels";
import { useWorkspace } from "#/components/workspace/context";
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
			{AGENT_RUNTIMES.map((runtime) => {
				const ofRuntime = agents.filter((agent) => agent.runtime === runtime);
				if (ofRuntime.length === 0) return null;
				return (
					<section key={runtime} aria-label={RUNTIME_NAMES[runtime]} className="space-y-2">
						<h2>
							<RuntimeBadge runtime={runtime} />
						</h2>
						<ul className="divide-y rounded-lg border">
							{ofRuntime.map((agent) => (
								<AgentRow key={agent.id} agent={agent} />
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}

function AgentRow({ agent }: { agent: Agent }) {
	const { slug } = useWorkspace();
	const repositories = Route.useLoaderData()?.repositories ?? [];
	const repository = repositories.find((candidate) => candidate.id === agent.repositoryId);
	const reads = agent.assetIds.length;

	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
			<span className="min-w-0 flex-1">
				<span className="font-medium">{agent.name}</span>
				{agent.description && (
					<span className="block truncate text-muted-foreground">{agent.description}</span>
				)}
			</span>
			{agent.model && (
				<span className="font-mono text-xs text-muted-foreground">{agent.model}</span>
			)}
			<span className="text-xs text-muted-foreground tabular-nums">
				{reads === 1 ? "1 asset" : `${reads} assets`}
			</span>
			{repository && (
				<Link
					to="/$workspace/repositories/$repositoryId"
					params={{ workspace: slug, repositoryId: repository.id }}
					className="w-48 truncate text-right text-xs hover:underline"
				>
					<span className="text-muted-foreground">{repository.owner}/</span>
					{repository.name}
				</Link>
			)}
		</li>
	);
}
