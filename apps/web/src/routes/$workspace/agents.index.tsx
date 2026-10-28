import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AgentDialog } from "#/components/registry/agent-dialogs";
import { AgentList } from "#/components/registry/agent-list";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { getProviderKeys } from "#/lib/providers";
import { createAgent, getAgents, getLibrary } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/agents/")({
	loader: ({ params }) => getAgents({ data: params.workspace }),
	component: AgentsPage,
});

function AgentsPage() {
	const data = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Agents");
	const agents = data?.agents ?? [];

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">Agents</h1>
					<p className="text-sm text-muted-foreground">
						The agents Gateweave runs, and the coding agents configured in your repositories.
					</p>
				</div>
				{admin && <NewAgentButton />}
			</header>
			{agents.length === 0 ? (
				<p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
					No agents yet. Coding agents appear here once a connected repository has been scanned, and
					agents run by Gateweave once someone defines one.
					{admin ? "" : " An owner or admin can define one."}
				</p>
			) : (
				<AgentList agents={agents} repositories={data?.repositories ?? []} />
			)}
		</div>
	);
}

function NewAgentButton() {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const [choices, setChoices] = useState<{
		library: Awaited<ReturnType<typeof getLibrary>>;
		keys: Awaited<ReturnType<typeof getProviderKeys>>;
	} | null>(null);
	const [loading, setLoading] = useState(false);

	async function open() {
		setLoading(true);
		try {
			const [library, keys] = await Promise.all([
				getLibrary({ data: slug }),
				getProviderKeys({ data: slug }),
			]);
			setChoices({ library, keys });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong");
		} finally {
			setLoading(false);
		}
	}

	return (
		<>
			<Button size="sm" onClick={open} disabled={loading}>
				<Plus />
				New agent
			</Button>
			{choices && (
				<AgentDialog
					library={choices.library ?? []}
					keyed={choices.keys?.keys.map((key) => key.provider) ?? []}
					onSave={async (agent) => {
						const created = await createAgent({ data: { slug, agent } });
						toast.success(`${created.name} was created`);
						await navigate({
							to: "/$workspace/agents/$agentId",
							params: { workspace: slug, agentId: created.id },
						});
					}}
					onClose={() => setChoices(null)}
				/>
			)}
		</>
	);
}
