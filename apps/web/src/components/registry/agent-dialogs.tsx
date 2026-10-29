import {
	type Agent,
	type AgentDefinition,
	type AgentDefinitionInput,
	INSTRUCTION_KINDS,
	isKeyedProvider,
	type LibraryEntry,
	MAX_AGENT_MCP_SERVERS,
	type McpCheck,
	type Metadata,
	MODEL_PROVIDER_NAMES,
	MODEL_PROVIDERS,
	type ModelProvider,
	type PinnedAsset,
	type ProviderModel,
	providerMissing,
	providerPickerNote,
} from "@gateweave/agents-model";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { useWorkspace } from "#/components/workspace/context";
import { getMcpServers, getModels } from "#/lib/registry";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

/**
 * Defines a new agent run by Gateweave, or changes `agent`. Models are listed with the
 * workspace's key for the provider (for Workers AI, with the server's own token); any model id
 * can be typed. Assets already pinned keep their version, and a newly chosen asset is pinned to
 * its latest.
 */
export function AgentDialog({
	agent,
	library,
	available,
	onSave,
	onClose,
}: {
	agent?: { agent: Agent; definition: AgentDefinition };
	library: LibraryEntry[];
	/** The providers an agent can use: the workspace has a key, or the server offers it. */
	available: ModelProvider[];
	onSave: (input: AgentDefinitionInput) => Promise<void>;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const pinned = agent?.definition.instructions ?? null;
	const pinnedEnv = agent?.definition.environment ?? null;
	const pinnedServers = agent?.definition.mcpServers ?? [];
	const [name, setName] = useState(agent?.agent.name ?? "");
	const [description, setDescription] = useState(agent?.agent.description ?? "");
	const [provider, setProvider] = useState<ModelProvider>(
		agent?.definition.provider ?? available[0] ?? "anthropic",
	);
	const [model, setModel] = useState(agent?.definition.model ?? "");
	const [instructions, setInstructions] = useState(pinned?.asset.id ?? "");
	const [environment, setEnvironment] = useState(pinnedEnv?.asset.id ?? "");
	const [servers, setServers] = useState(
		() => new Set(pinnedServers.map((server) => server.asset.id)),
	);
	// The tools each pinned server is limited to; null is all of them.
	const [allowed, setAllowed] = useState(
		() => new Map(pinnedServers.map((server) => [server.asset.id, server.tools])),
	);
	// The last check of each library server, which says what tools there are to choose from.
	const [checks, setChecks] = useState<Map<string, McpCheck | null>>(() => new Map());
	const [models, setModels] = useState<ProviderModel[] | string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const usable = available.includes(provider);

	useEffect(() => {
		let live = true;
		getMcpServers({ data: slug })
			.then((found) => {
				if (live) setChecks(new Map((found ?? []).map((entry) => [entry.asset.id, entry.check])));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [slug]);

	useEffect(() => {
		setModels(null);
		if (!usable) return;
		let live = true;
		getModels({ data: { slug, provider } })
			.then((found) => live && setModels(found))
			.catch((failure) => live && setModels(message(failure)));
		return () => {
			live = false;
		};
	}, [slug, provider, usable]);

	const choices = library.filter(({ asset }) =>
		(INSTRUCTION_KINDS as readonly string[]).includes(asset.kind),
	);

	const sets = library.filter(({ asset }) => asset.kind === "env-set");

	// Pinned servers first, so one that left the library can still be unpinned.
	const serverChoices = [
		...pinnedServers.map((pin) => pin.asset),
		...library.map(({ asset }) => asset).filter((asset) => asset.kind === "mcp-server"),
	].filter((asset, index, all) => all.findIndex(({ id }) => id === asset.id) === index);

	function toggleServer(assetId: string, on: boolean) {
		setServers((current) => {
			const next = new Set(current);
			if (on) next.add(assetId);
			else next.delete(assetId);
			return next;
		});
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const pin = pinFor(instructions, pinned, choices);
		const environmentPin = pinFor(environment, pinnedEnv, sets);
		try {
			await onSave({
				name: name.trim(),
				description: description.trim() || null,
				provider,
				model: model.trim(),
				instructions: pin,
				environment: environmentPin,
				mcpServers: serverChoices
					.filter((asset) => servers.has(asset.id))
					.map((asset) => {
						const kept = pinnedServers.find((server) => server.asset.id === asset.id);
						return {
							assetId: asset.id,
							version: kept?.version ?? asset.version,
							tools: allowed.get(asset.id) ?? null,
						};
					}),
			});
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{agent ? "Edit agent" : "New agent"}</DialogTitle>
						<DialogDescription>
							An agent run by Gateweave calls a model with the workspace's key for its provider, and
							always reads its instructions from the library.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="agent-name">Name</Label>
						<Input
							id="agent-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							autoFocus
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="agent-description">Description</Label>
						<Textarea
							id="agent-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							maxLength={2000}
							rows={2}
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-2">
							<Label htmlFor="agent-provider">Provider</Label>
							<select
								id="agent-provider"
								value={provider}
								onChange={(event) => setProvider(event.target.value as ModelProvider)}
								className={SELECT}
							>
								{MODEL_PROVIDERS.map((option) => (
									<option key={option} value={option}>
										{MODEL_PROVIDER_NAMES[option]}
										{available.includes(option) ? "" : providerPickerNote(option)}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-model">Model</Label>
							<Input
								id="agent-model"
								list="agent-models"
								value={model}
								onChange={(event) => setModel(event.target.value)}
								maxLength={200}
								spellCheck={false}
								autoComplete="off"
								required
							/>
							{Array.isArray(models) && (
								<datalist id="agent-models">
									{models.map((option) => (
										<option key={option.id} value={option.id}>
											{option.name}
										</option>
									))}
								</datalist>
							)}
						</div>
					</div>
					<ModelsHint provider={provider} usable={usable} models={models} />
					<div className="space-y-2">
						<Label htmlFor="agent-instructions">Instructions</Label>
						<select
							id="agent-instructions"
							value={instructions}
							onChange={(event) => setInstructions(event.target.value)}
							className={SELECT}
						>
							<option value="">None</option>
							{pinned?.removed && (
								<option value={pinned.asset.id}>
									{pinned.asset.name} (v{pinned.version}, left the library)
								</option>
							)}
							{choices.map(({ asset }) => (
								<option key={asset.id} value={asset.id}>
									{asset.name} (
									{asset.id === pinned?.asset.id ? `v${pinned.version}` : `v${asset.version}`})
								</option>
							))}
						</select>
						{choices.length === 0 && !pinned && (
							<p className="text-xs text-muted-foreground">
								Write instructions or a prompt in the library first.
							</p>
						)}
					</div>
					<div className="space-y-2">
						<Label htmlFor="agent-environment">Environment</Label>
						<select
							id="agent-environment"
							value={environment}
							onChange={(event) => setEnvironment(event.target.value)}
							className={SELECT}
						>
							<option value="">None</option>
							{pinnedEnv?.removed && (
								<option value={pinnedEnv.asset.id}>
									{pinnedEnv.asset.name} (v{pinnedEnv.version}, left the library)
								</option>
							)}
							{sets.map(({ asset }) => (
								<option key={asset.id} value={asset.id}>
									{asset.name} (
									{asset.id === pinnedEnv?.asset.id ? `v${pinnedEnv.version}` : `v${asset.version}`}
									)
								</option>
							))}
						</select>
						<p className="text-xs text-muted-foreground">
							{sets.length === 0 && !pinnedEnv
								? "Create an environment set on the Environment page to give the agent variables and secrets."
								: "The variables and secrets the agent runs with."}
						</p>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">MCP servers</legend>
						{serverChoices.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								Add an MCP server in the library to give the agent its tools.
							</p>
						) : (
							<ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
								{serverChoices.map((asset) => {
									const kept = pinnedServers.find((server) => server.asset.id === asset.id);
									const local = !kept && runsLocally(asset.metadata);
									const full = !servers.has(asset.id) && servers.size >= MAX_AGENT_MCP_SERVERS;
									return (
										<li key={asset.id}>
											<Label className="flex cursor-pointer items-center gap-3 p-2.5 font-normal hover:bg-accent/50 has-disabled:cursor-not-allowed has-disabled:opacity-60">
												<Checkbox
													checked={servers.has(asset.id)}
													disabled={local || full}
													onCheckedChange={(checked) => toggleServer(asset.id, checked === true)}
												/>
												<span className="min-w-0 flex-1 truncate">{asset.name}</span>
												<span className="shrink-0 text-xs text-muted-foreground">
													{kept
														? `v${kept.version}${kept.removed ? ", left the library" : ""}`
														: local
															? "runs locally"
															: `v${asset.version}`}
												</span>
											</Label>
											{servers.has(asset.id) && (
												<ToolChoice
													offered={checks.get(asset.id)}
													tools={allowed.get(asset.id) ?? null}
													onChange={(tools) =>
														setAllowed((current) => new Map(current).set(asset.id, tools))
													}
												/>
											)}
										</li>
									);
								})}
							</ul>
						)}
						<p className="text-xs text-muted-foreground">
							Their tools become the agent's. A server that runs as a local command cannot be
							reached by Gateweave yet.
						</p>
					</fieldset>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || !name.trim() || !model.trim()}>
							{agent ? "Save" : "Create agent"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Limits a chosen server to some of its tools. The choices are the tools its last check listed;
 * without one, the pin keeps the list it has, so saving never drops it unseen.
 */
function ToolChoice({
	offered,
	tools,
	onChange,
}: {
	offered: McpCheck | null | undefined;
	tools: string[] | null;
	onChange: (tools: string[] | null) => void;
}) {
	const listed = offered?.ok ? offered.tools.map((tool) => tool.name) : [];
	if (listed.length === 0) {
		return (
			<p className="px-2.5 pb-2.5 pl-10 text-xs text-muted-foreground">
				{tools ? `Only: ${tools.join(", ")}. ` : "All of its tools. "}
				Check the server on the MCP page to choose its tools.
			</p>
		);
	}
	// A tool kept from before that the server no longer lists stays visible, so it can be dropped.
	const choices = [...listed, ...(tools ?? []).filter((tool) => !listed.includes(tool))];
	return (
		<div className="space-y-1.5 px-2.5 pb-2.5 pl-10">
			<Label className="flex cursor-pointer items-center gap-2 text-xs font-normal">
				<Checkbox
					checked={tools === null}
					onCheckedChange={(checked) => onChange(checked === true ? null : listed)}
				/>
				All tools
			</Label>
			{tools !== null && (
				<ul className="max-h-32 space-y-1 overflow-y-auto">
					{choices.map((tool) => (
						<li key={tool}>
							<Label className="flex cursor-pointer items-center gap-2 font-mono text-xs font-normal has-disabled:cursor-not-allowed">
								<Checkbox
									checked={tools.includes(tool)}
									// One tool stays: an empty list would mean no tools, which is leaving the server out.
									disabled={tools.length === 1 && tools.includes(tool)}
									onCheckedChange={(checked) =>
										onChange(
											checked === true
												? choices.filter((name) => name === tool || tools.includes(name))
												: tools.filter((name) => name !== tool),
										)
									}
								/>
								<span className="min-w-0 truncate">{tool}</span>
							</Label>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Whether a server, as its metadata describes it, is a command rather than a URL. */
function runsLocally(metadata: Metadata): boolean {
	return metadata.type === "stdio" || typeof metadata.command === "string";
}

/** What to pin for a select's choice: the version already pinned, or the latest of a new asset. */
function pinFor(
	chosenId: string,
	pinned: PinnedAsset | null,
	choices: LibraryEntry[],
): { assetId: string; version: number } | null {
	if (pinned && chosenId === pinned.asset.id) {
		return { assetId: pinned.asset.id, version: pinned.version };
	}
	const chosen = choices.find(({ asset }) => asset.id === chosenId)?.asset;
	return chosen ? { assetId: chosen.id, version: chosen.version } : null;
}

function ModelsHint({
	provider,
	usable,
	models,
}: {
	provider: ModelProvider;
	usable: boolean;
	models: ProviderModel[] | string | null;
}) {
	const { slug } = useWorkspace();
	const name = MODEL_PROVIDER_NAMES[provider];
	if (!usable && !isKeyedProvider(provider)) {
		return (
			<p className="-mt-2 text-xs text-muted-foreground">
				{providerMissing(provider)}, so this agent cannot run until whoever runs the server turns it
				on. Type the model's id meanwhile.
			</p>
		);
	}
	if (!usable) {
		return (
			<p className="-mt-2 text-xs text-muted-foreground">
				The workspace has no {name} key yet, so this agent cannot run until someone adds one in{" "}
				<Link
					to="/$workspace/settings/models"
					params={{ workspace: slug }}
					className="underline underline-offset-2"
				>
					Settings
				</Link>
				. Type the model's id meanwhile.
			</p>
		);
	}
	if (models === null) {
		return <p className="-mt-2 text-xs text-muted-foreground">Asking {name} for its models…</p>;
	}
	if (typeof models === "string") {
		return <p className="-mt-2 text-xs text-destructive">{models}. Type the model's id instead.</p>;
	}
	return (
		<p className="-mt-2 text-xs text-muted-foreground">
			{models.length === 1 ? "1 model" : `${models.length} models`} available{" "}
			{isKeyedProvider(provider) ? `with the workspace's ${name} key` : `on this server`}.
		</p>
	);
}
