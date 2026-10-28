import {
	type AgentDefinition,
	type AgentDetail,
	MODEL_PROVIDER_NAMES,
	type PinnedAsset,
} from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { AgentDialog } from "#/components/registry/agent-dialogs";
import { KindLabel, RuntimeBadge } from "#/components/registry/labels";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { getProviderKeys } from "#/lib/providers";
import { getAgent, getLibrary, removeAgent, updateAgent } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/agents/$agentId")({
	loader: async ({ params }) => {
		const [detail, library, keys] = await Promise.all([
			getAgent({ data: { slug: params.workspace, agentId: params.agentId } }),
			getLibrary({ data: params.workspace }),
			getProviderKeys({ data: params.workspace }),
		]);
		return (
			detail && {
				...detail,
				library: library ?? [],
				keyed: keys?.keys.map((key) => key.provider) ?? [],
			}
		);
	},
	component: AgentPage,
});

function AgentPage() {
	const data = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle(data ? data.agent.name : "Agent");

	if (!data) {
		return <Notice title="Agent not found">It may have been removed.</Notice>;
	}
	const { agent, definition } = data;

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-2">
					<h1 className="text-xl font-semibold tracking-tight">{agent.name}</h1>
					{agent.description && (
						<p className="text-sm whitespace-pre-line text-muted-foreground">{agent.description}</p>
					)}
					<p>
						<RuntimeBadge runtime={agent.runtime} />
					</p>
				</div>
				{admin && definition && <AgentActions definition={definition} />}
			</header>
			{definition ? <Definition definition={definition} admin={admin} /> : <Configured />}
		</div>
	);
}

/** The model and instructions of an agent run by Gateweave. */
function Definition({ definition, admin }: { definition: AgentDefinition; admin: boolean }) {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	if (!data) return null;
	const provider = MODEL_PROVIDER_NAMES[definition.provider];

	return (
		<>
			<section aria-labelledby="model-heading" className="space-y-3">
				<h2 id="model-heading" className="text-sm font-medium">
					Model
				</h2>
				<p className="rounded-lg border p-3 text-sm">
					{provider} · <span className="font-mono">{definition.model}</span>
				</p>
				{!data.keyed.includes(definition.provider) && (
					<p className="text-sm text-amber-600 dark:text-amber-500">
						The workspace has no {provider} key, so this agent cannot run yet.{" "}
						{admin ? (
							<Link
								to="/$workspace/settings/models"
								params={{ workspace: slug }}
								className="underline underline-offset-2"
							>
								Add one in Settings
							</Link>
						) : (
							"An owner or admin can add one in Settings."
						)}
					</p>
				)}
			</section>

			<section aria-labelledby="instructions-heading" className="space-y-3">
				<h2 id="instructions-heading" className="text-sm font-medium">
					Instructions
				</h2>
				{definition.instructions ? (
					<>
						<ul className="rounded-lg border text-sm">
							<InstructionsRow pin={definition.instructions} admin={admin} />
						</ul>
						{data.instructions.map((file) => (
							<details key={file.path} open className="overflow-hidden rounded-lg border">
								<summary className="cursor-pointer bg-muted/40 px-3 py-2 font-mono text-xs">
									{file.path}
								</summary>
								<pre className="max-h-[32rem] overflow-auto border-t p-3 text-xs leading-relaxed whitespace-pre-wrap">
									<code>{file.content}</code>
								</pre>
							</details>
						))}
					</>
				) : (
					<p className="rounded-lg border p-6 text-sm text-muted-foreground">
						No instructions: the model gets only the conversation.
						{admin ? " Choose some from the library with Edit." : ""}
					</p>
				)}
			</section>
		</>
	);
}

/** The pinned instructions, and their newer version if the library has one. */
function InstructionsRow({ pin, admin }: { pin: PinnedAsset; admin: boolean }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const data = Route.useLoaderData();
	const [pending, setPending] = useState(false);
	const { asset, version, removed } = pin;
	const update = !removed && version < asset.version;

	async function moveToLatest() {
		if (!data?.definition) return;
		setPending(true);
		try {
			const { agent, definition } = data;
			await updateAgent({
				data: {
					slug,
					agentId: agent.id,
					agent: {
						name: agent.name,
						description: agent.description,
						provider: definition.provider,
						model: definition.model,
						instructions: { assetId: asset.id, version: asset.version },
					},
				},
			});
			toast.success(`${agent.name} reads v${asset.version} of ${asset.name}`);
			await router.invalidate();
		} catch (error) {
			toast.error("Could not move the pin", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setPending(false);
		}
	}

	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
			<KindLabel kind={asset.kind} />
			<span className="min-w-0 flex-1 truncate">
				{removed ? (
					asset.name
				) : (
					<Link
						to="/$workspace/assets/$assetId"
						params={{ workspace: slug, assetId: asset.id }}
						search={{ version }}
						className="hover:underline"
					>
						{asset.name}
					</Link>
				)}
			</span>
			<span className="text-xs tabular-nums">
				<span className="text-muted-foreground">v{version}</span>
				{removed && <span className="text-muted-foreground">, left the library</span>}
				{update && (
					<span className="text-amber-600 dark:text-amber-500">, v{asset.version} is out</span>
				)}
			</span>
			{update && admin && (
				<Button variant="outline" size="sm" onClick={moveToLatest} disabled={pending}>
					Use v{asset.version}
				</Button>
			)}
		</li>
	);
}

/** Where a coding agent found in a repository is configured, and what it reads. */
function Configured() {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	if (!data) return null;
	const { agent, repository, assets } = data;

	return (
		<>
			<section aria-labelledby="configured-heading" className="space-y-3">
				<h2 id="configured-heading" className="text-sm font-medium">
					Configured in
				</h2>
				<dl className="divide-y rounded-lg border text-sm">
					{repository && (
						<Field label="Repository">
							<Link
								to="/$workspace/repositories/$repositoryId"
								params={{ workspace: slug, repositoryId: repository.id }}
								className="hover:underline"
							>
								{repository.owner}/{repository.name}
							</Link>
						</Field>
					)}
					{agent.path && (
						<Field label="File">
							<span className="font-mono text-xs">{agent.path}</span>
						</Field>
					)}
					{agent.model && (
						<Field label="Model">
							<span className="font-mono text-xs">{agent.model}</span>
						</Field>
					)}
				</dl>
			</section>
			<Reads assets={assets} />
		</>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1 p-3">
			<dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 flex-1 truncate">{children}</dd>
		</div>
	);
}

function Reads({ assets }: Pick<AgentDetail, "assets">) {
	const { slug } = useWorkspace();
	return (
		<section aria-labelledby="reads-heading" className="space-y-3">
			<h2 id="reads-heading" className="text-sm font-medium">
				{assets.length === 0 ? "Reads" : `Reads · ${assets.length}`}
			</h2>
			{assets.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					The last scan found nothing this agent reads.
				</p>
			) : (
				<ul className="divide-y rounded-lg border text-sm">
					{assets.map((asset) => (
						<li key={asset.id} className="flex items-center gap-3 p-3">
							<KindLabel kind={asset.kind} />
							<Link
								to="/$workspace/assets/$assetId"
								params={{ workspace: slug, assetId: asset.id }}
								className="min-w-0 flex-1 truncate hover:underline"
							>
								{asset.name}
							</Link>
							{asset.path && (
								<span className="truncate font-mono text-xs text-muted-foreground">
									{asset.path}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function AgentActions({ definition }: { definition: AgentDefinition }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const navigate = useNavigate();
	const data = Route.useLoaderData();
	const [open, setOpen] = useState<"edit" | "remove" | null>(null);
	if (!data) return null;
	const { agent } = data;
	const close = () => setOpen(null);

	return (
		<div className="flex shrink-0 flex-wrap gap-2">
			<Button variant="ghost" size="sm" onClick={() => setOpen("edit")}>
				<Pencil />
				Edit
			</Button>
			<Button variant="ghost" size="sm" onClick={() => setOpen("remove")}>
				<Trash2 />
				<span className="sr-only sm:not-sr-only">Remove</span>
			</Button>
			{open === "edit" && (
				<AgentDialog
					agent={{ agent, definition }}
					library={data.library}
					keyed={data.keyed}
					onSave={async (input) => {
						await updateAgent({ data: { slug, agentId: agent.id, agent: input } });
						await router.invalidate();
					}}
					onClose={close}
				/>
			)}
			{open === "remove" && (
				<ConfirmDialog
					title={`Remove ${agent.name}?`}
					confirmLabel="Remove"
					onConfirm={async () => {
						try {
							await removeAgent({ data: { slug, agentId: agent.id } });
						} catch (error) {
							toast.error(error instanceof Error ? error.message : "Something went wrong");
							return;
						}
						toast.success(`${agent.name} was removed`);
						await navigate({ to: "/$workspace/agents", params: { workspace: slug } });
					}}
					onClose={close}
				>
					It stops answering. Its instructions stay in the library.
				</ConfirmDialog>
			)}
		</div>
	);
}
