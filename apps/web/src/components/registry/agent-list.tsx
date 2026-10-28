import {
	AGENT_RUNTIMES,
	type Agent,
	type Repository,
	RUNTIME_NAMES,
} from "@gateweave/agents-model";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "#/components/workspace/context";
import { RuntimeBadge } from "./labels";

/** Agents grouped by runtime, each with the repository it is configured in. */
export function AgentList({
	agents,
	repositories,
	headingLevel: Heading = "h2",
}: {
	agents: Agent[];
	repositories: Repository[];
	/** The level of each runtime's heading, under the page's own. */
	headingLevel?: "h2" | "h3";
}) {
	const byId = new Map(repositories.map((repository) => [repository.id, repository]));
	return AGENT_RUNTIMES.map((runtime) => {
		const ofRuntime = agents.filter((agent) => agent.runtime === runtime);
		if (ofRuntime.length === 0) return null;
		return (
			<section key={runtime} aria-label={RUNTIME_NAMES[runtime]} className="space-y-2">
				<Heading>
					<RuntimeBadge runtime={runtime} />
				</Heading>
				<ul className="divide-y rounded-lg border">
					{ofRuntime.map((agent) => (
						<AgentRow
							key={agent.id}
							agent={agent}
							repository={agent.repositoryId ? byId.get(agent.repositoryId) : undefined}
						/>
					))}
				</ul>
			</section>
		);
	});
}

function AgentRow({ agent, repository }: { agent: Agent; repository: Repository | undefined }) {
	const { slug } = useWorkspace();
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
