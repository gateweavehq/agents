import type { ModelProvider, SandboxOffer } from "@gateweave/agents-model";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GitPullRequest, type LucideIcon, Plus, Tags } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AgentDialog } from "#/components/registry/agent-dialogs";
import { AgentList } from "#/components/registry/agent-list";
import { TrackTriageDialog } from "#/components/registry/track-triage-dialog";
import { TrackWorkDialog } from "#/components/registry/track-work-dialog";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { availableProviders } from "#/lib/available-providers";
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
			{admin && <ReadyMade />}
		</div>
	);
}

/** Agents set up in one step, with everything they need around them. */
function ReadyMade() {
	const { slug } = useWorkspace();
	const [open, setOpen] = useState<{
		which: "triage" | "work";
		available: ModelProvider[];
		sandbox: SandboxOffer;
	} | null>(null);
	const [loading, setLoading] = useState(false);

	async function choose(which: "triage" | "work") {
		setLoading(true);
		try {
			const keys = await getProviderKeys({ data: slug });
			setOpen({ which, available: availableProviders(keys), sandbox: keys?.sandbox ?? "none" });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong");
		} finally {
			setLoading(false);
		}
	}

	return (
		<section className="space-y-3">
			<h2 className="text-sm font-medium">Ready-made</h2>
			<ReadyMadeCard
				icon={Tags}
				title="Triage Track issues"
				description="Labels, prioritizes and comments on each new issue in Gateweave Track, and points out likely duplicates."
				disabled={loading}
				onSetUp={() => choose("triage")}
			/>
			<ReadyMadeCard
				icon={GitPullRequest}
				title="Work on Track issues"
				description="Takes the Gateweave Track issues assigned to it, works on each in a sandbox with your repository, opens a pull request and reports back on the issue."
				disabled={loading}
				onSetUp={() => choose("work")}
			/>
			{open?.which === "triage" && (
				<TrackTriageDialog available={open.available} onClose={() => setOpen(null)} />
			)}
			{open?.which === "work" && (
				<TrackWorkDialog
					available={open.available}
					sandboxOffer={open.sandbox}
					onClose={() => setOpen(null)}
				/>
			)}
		</section>
	);
}

function ReadyMadeCard({
	icon: Icon,
	title,
	description,
	disabled,
	onSetUp,
}: {
	icon: LucideIcon;
	title: string;
	description: string;
	disabled: boolean;
	onSetUp: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
			<div className="flex min-w-0 items-start gap-3">
				<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div className="space-y-1">
					<p className="text-sm font-medium">{title}</p>
					<p className="text-sm text-muted-foreground">{description}</p>
				</div>
			</div>
			<Button size="sm" variant="outline" onClick={onSetUp} disabled={disabled}>
				Set up
			</Button>
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
					available={availableProviders(choices.keys)}
					sandboxOffer={choices.keys?.sandbox ?? "none"}
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
