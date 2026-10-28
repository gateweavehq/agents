import {
	type Agent,
	type AgentDefinition,
	type AgentDefinitionInput,
	INSTRUCTION_KINDS,
	type LibraryEntry,
	MODEL_PROVIDER_NAMES,
	MODEL_PROVIDERS,
	type ModelProvider,
	type PinnedAsset,
	type ProviderModel,
} from "@gateweave/agents-model";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
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
import { getModels } from "#/lib/registry";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

/**
 * Defines a new agent run by Gateweave, or changes `agent`. Models are listed with the
 * workspace's key for the provider; any model id can be typed. Instructions already pinned keep
 * their version, and a newly chosen asset is pinned to its latest.
 */
export function AgentDialog({
	agent,
	library,
	keyed,
	onSave,
	onClose,
}: {
	agent?: { agent: Agent; definition: AgentDefinition };
	library: LibraryEntry[];
	/** The providers the workspace has a key for. */
	keyed: ModelProvider[];
	onSave: (input: AgentDefinitionInput) => Promise<void>;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const pinned = agent?.definition.instructions ?? null;
	const pinnedEnv = agent?.definition.environment ?? null;
	const [name, setName] = useState(agent?.agent.name ?? "");
	const [description, setDescription] = useState(agent?.agent.description ?? "");
	const [provider, setProvider] = useState<ModelProvider>(
		agent?.definition.provider ?? keyed[0] ?? "anthropic",
	);
	const [model, setModel] = useState(agent?.definition.model ?? "");
	const [instructions, setInstructions] = useState(pinned?.asset.id ?? "");
	const [environment, setEnvironment] = useState(pinnedEnv?.asset.id ?? "");
	const [models, setModels] = useState<ProviderModel[] | string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const hasKey = keyed.includes(provider);

	useEffect(() => {
		setModels(null);
		if (!hasKey) return;
		let live = true;
		getModels({ data: { slug, provider } })
			.then((found) => live && setModels(found))
			.catch((failure) => live && setModels(message(failure)));
		return () => {
			live = false;
		};
	}, [slug, provider, hasKey]);

	const choices = library.filter(({ asset }) =>
		(INSTRUCTION_KINDS as readonly string[]).includes(asset.kind),
	);

	const sets = library.filter(({ asset }) => asset.kind === "env-set");

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
			<DialogContent className="max-w-md">
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
										{keyed.includes(option) ? "" : " (no key)"}
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
					<ModelsHint provider={provider} hasKey={hasKey} models={models} />
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
	hasKey,
	models,
}: {
	provider: ModelProvider;
	hasKey: boolean;
	models: ProviderModel[] | string | null;
}) {
	const { slug } = useWorkspace();
	const name = MODEL_PROVIDER_NAMES[provider];
	if (!hasKey) {
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
			{models.length === 1 ? "1 model" : `${models.length} models`} available with the workspace's{" "}
			{name} key.
		</p>
	);
}
