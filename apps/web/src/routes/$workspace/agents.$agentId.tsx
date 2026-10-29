import {
	type Agent,
	type AgentDefinition,
	type AgentDetail,
	type AgentMcpServer,
	isKeyedProvider,
	MODEL_PROVIDER_NAMES,
	type PinnedAsset,
	providerMissing,
	SANDBOX_REPOSITORY_PATH,
} from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { MessagesSquare, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { AgentDialog } from "#/components/registry/agent-dialogs";
import { KindLabel, RuntimeBadge } from "#/components/registry/labels";
import { Triggers } from "#/components/registry/triggers";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { availableProviders } from "#/lib/available-providers";
import { startChat } from "#/lib/chat";
import { getProviderKeys } from "#/lib/providers";
import { getAgent, getLibrary, removeAgent, updateAgent } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";
import { getTriggers } from "#/lib/triggers";

export const Route = createFileRoute("/$workspace/agents/$agentId")({
	loader: async ({ params }) => {
		const [detail, library, keys, triggers] = await Promise.all([
			getAgent({ data: { slug: params.workspace, agentId: params.agentId } }),
			getLibrary({ data: params.workspace }),
			getProviderKeys({ data: params.workspace }),
			getTriggers({
				data: { slug: params.workspace, target: { kind: "agent", agentId: params.agentId } },
			}),
		]);
		return (
			detail && {
				...detail,
				library: library ?? [],
				available: availableProviders(keys),
				sandboxOffered: keys?.sandbox ?? false,
				// Null for members: owners and admins manage triggers.
				triggers,
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
				{definition && (
					<div className="flex flex-wrap gap-2">
						<ChatButton agentId={agent.id} />
						{admin && <AgentActions definition={definition} />}
					</div>
				)}
			</header>
			{definition ? <Definition definition={definition} admin={admin} /> : <Configured />}
			{definition && data.triggers && (
				<Triggers
					target={{ kind: "agent", agentId: agent.id }}
					targetName={agent.name}
					triggers={data.triggers}
				/>
			)}
		</div>
	);
}

/** Starts a conversation with the agent, and opens it. */
function ChatButton({ agentId }: { agentId: string }) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const [pending, setPending] = useState(false);

	async function start() {
		setPending(true);
		try {
			const conversation = await startChat({ data: { slug, agentId } });
			await navigate({
				to: "/$workspace/chat/$conversationId",
				params: { workspace: slug, conversationId: conversation.id },
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong");
			setPending(false);
		}
	}

	return (
		<Button size="sm" onClick={start} disabled={pending}>
			<MessagesSquare />
			Chat
		</Button>
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
				{!data.available.includes(definition.provider) && (
					<p className="text-sm text-amber-600 dark:text-amber-500">
						{providerMissing(definition.provider)}, so this agent cannot run yet.{" "}
						{!isKeyedProvider(definition.provider) ? (
							"Whoever runs the server can turn it on."
						) : admin ? (
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
							<PinRow field="instructions" pin={definition.instructions} admin={admin} />
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

			<section aria-labelledby="environment-heading" className="space-y-3">
				<h2 id="environment-heading" className="text-sm font-medium">
					Environment
				</h2>
				{definition.environment ? (
					<>
						<ul className="rounded-lg border text-sm">
							<PinRow field="environment" pin={definition.environment} admin={admin} />
						</ul>
						<p className="text-xs text-muted-foreground">
							Its variables and secrets are on the{" "}
							<Link
								to="/$workspace/environment"
								params={{ workspace: slug }}
								className="underline underline-offset-2"
							>
								Environment page
							</Link>
							.
						</p>
					</>
				) : (
					<p className="rounded-lg border p-6 text-sm text-muted-foreground">
						No environment: the agent runs with no variables or secrets.
						{admin ? " Choose a set with Edit." : ""}
					</p>
				)}
			</section>

			<section aria-labelledby="sandbox-heading" className="space-y-3">
				<h2 id="sandbox-heading" className="text-sm font-medium">
					Sandbox
				</h2>
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					{definition.sandbox
						? data.sandboxOffered
							? "Each conversation has a Linux machine of its own, where the agent runs commands and edits files. It can download packages, and reach nothing else. It stops after 15 minutes without use, and its files go with it."
							: "The agent has a sandbox, but this server runs none, so it cannot answer. Whoever runs the server can turn sandboxes on."
						: `No sandbox: the agent cannot run commands.${admin && data.sandboxOffered ? " Give it one with Edit." : ""}`}
				</p>
				{definition.sandbox && definition.repository && (
					<p className="rounded-lg border p-6 text-sm text-muted-foreground">
						{definition.repository.removed ? (
							<>
								The workspace's GitHub App no longer reaches{" "}
								<span className="font-medium text-foreground">
									{definition.repository.owner}/{definition.repository.name}
								</span>
								, so the agent cannot answer.
								{admin ? " Choose another repository with Edit." : ""}
							</>
						) : (
							<>
								Each conversation checks out{" "}
								<Link
									to="/$workspace/repositories/$repositoryId"
									params={{ workspace: slug, repositoryId: definition.repository.id }}
									className="font-medium text-foreground underline-offset-4 hover:underline"
								>
									{definition.repository.owner}/{definition.repository.name}
								</Link>{" "}
								at <code>{SANDBOX_REPOSITORY_PATH}</code>, on a branch of its own.
							</>
						)}
					</p>
				)}
			</section>

			<section aria-labelledby="mcp-heading" className="space-y-3">
				<h2 id="mcp-heading" className="text-sm font-medium">
					{definition.mcpServers.length === 0
						? "MCP servers"
						: `MCP servers · ${definition.mcpServers.length}`}
				</h2>
				{definition.mcpServers.length > 0 ? (
					<ul className="divide-y rounded-lg border text-sm">
						{definition.mcpServers.map((server) => (
							<PinRow key={server.asset.id} field="mcp-server" pin={server} admin={admin}>
								<McpServerState server={server} />
							</PinRow>
						))}
					</ul>
				) : (
					<p className="rounded-lg border p-6 text-sm text-muted-foreground">
						{definition.sandbox
							? "No MCP servers: the agent has only its sandbox's tools."
							: "No MCP servers: the agent has no tools."}
						{admin ? " Choose servers from the library with Edit." : ""}
					</p>
				)}
			</section>
		</>
	);
}

/** Where the agent reaches a server, and the variables its headers need. */
function McpServerState({ server }: { server: AgentMcpServer }) {
	const { slug } = useWorkspace();
	const { connection, variables } = server;
	const missing = variables.filter((variable) => variable.state === "missing");

	return (
		<div className="w-full space-y-1 text-xs text-muted-foreground">
			{server.tools && (
				<p>
					Only: <span className="font-mono">{server.tools.join(", ")}</span>
				</p>
			)}
			{"problem" in connection ? (
				<p className="text-destructive">{connection.problem}</p>
			) : (
				<p className="truncate">
					{connection.transport === "sse" ? "SSE" : "Streamable HTTP"} ·{" "}
					<span className="font-mono">{connection.url}</span>
				</p>
			)}
			{variables.length > 0 && (
				<p>
					Its headers use <Names names={variables.map((variable) => variable.name)} />.
					{missing.length > 0 && (
						<>
							{" "}
							<span className="text-amber-600 dark:text-amber-500">
								<Names names={missing.map((variable) => variable.name)} />{" "}
								{missing.length === 1 ? "has" : "have"} no value in the agent's environment set
							</span>
							; set {missing.length === 1 ? "it" : "them"} on the{" "}
							<Link
								to="/$workspace/environment"
								params={{ workspace: slug }}
								className="underline underline-offset-2"
							>
								Environment page
							</Link>
							.
						</>
					)}
				</p>
			)}
		</div>
	);
}

function Names({ names }: { names: string[] }) {
	return names.map((name, index) => (
		<span key={name}>
			{index > 0 && ", "}
			<code>{name}</code>
		</span>
	));
}

/** A pinned library asset, and its newer version if the library has one. */
function PinRow({
	field,
	pin,
	admin,
	children,
}: {
	field: "instructions" | "environment" | "mcp-server";
	pin: PinnedAsset;
	admin: boolean;
	children?: ReactNode;
}) {
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
			// Only the pin of this row moves; the others stay where they are.
			const input = inputOf(agent, definition);
			const latest = { assetId: asset.id, version: asset.version };
			if (field === "mcp-server") {
				// The newer version keeps the tools the agent was limited to.
				input.mcpServers = input.mcpServers.map((server) =>
					server.assetId === asset.id ? { ...server, version: asset.version } : server,
				);
			} else {
				input[field] = latest;
			}
			await updateAgent({ data: { slug, agentId: agent.id, agent: input } });
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
			{children}
		</li>
	);
}

/** The update that leaves an agent as it is, with every pin where it is. */
function inputOf(agent: Agent, definition: AgentDefinition) {
	return {
		name: agent.name,
		description: agent.description,
		provider: definition.provider,
		model: definition.model,
		instructions: keep(definition.instructions),
		environment: keep(definition.environment),
		mcpServers: definition.mcpServers.map((server) => ({
			assetId: server.asset.id,
			version: server.version,
			tools: server.tools,
		})),
		sandbox: definition.sandbox,
		repositoryId: definition.repository?.id ?? null,
	};
}

/** What an agent update sends for a pin it keeps. */
function keep(pin: PinnedAsset | null): { assetId: string; version: number } | null {
	return pin && { assetId: pin.asset.id, version: pin.version };
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
					available={data.available}
					sandboxOffered={data.sandboxOffered}
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
