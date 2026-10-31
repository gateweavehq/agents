import {
	AGENT_ENGINES,
	type AgentEngine,
	ENGINE_NAMES,
	ENGINE_PROVIDERS,
	isKeyedProvider,
	MODEL_PROVIDER_NAMES,
	MODEL_PROVIDERS,
	type ModelProvider,
	providerMissing,
	providerPickerNote,
	type Repository,
	type SandboxOffer,
} from "@gateweave/agents-model";
import { type FormEvent, useEffect, useState } from "react";
import { TrackWebhookStep } from "#/components/registry/track-webhook-step";
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
import { useWorkspace } from "#/components/workspace/context";
import { getRepositories } from "#/lib/registry";
import { setUpTrackWork, type TrackWorkSetUp } from "#/lib/track-work";

/** Where Gateweave Cloud's Track is, which most people use. */
const GATEWEAVE_TRACK = "https://track.gateweave.com";

/** A model to start from for each provider: coding takes a capable one. */
const SUGGESTED_MODELS: Partial<Record<ModelProvider, string>> = {
	anthropic: "claude-sonnet-5-5",
	openai: "gpt-5.5",
};

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/** The engine to start from: a vendor's coding agent the workspace has a key for, if any. */
function firstEngine(available: ModelProvider[]): AgentEngine {
	for (const engine of ["claude-code", "codex", "opencode"] as const) {
		if (ENGINE_PROVIDERS[engine].some((provider) => available.includes(provider))) return engine;
	}
	return "gateweave";
}

/** The providers an engine calls; Gateweave's own loop calls any. */
function providersOf(engine: AgentEngine): readonly ModelProvider[] {
	return engine === "gateweave" ? MODEL_PROVIDERS : ENGINE_PROVIDERS[engine];
}

/**
 * Sets up an agent that works on the Track issues assigned to it: first Track's URL, the agent
 * member's key, the repository and how it works, which make the agent and its trigger; then the
 * webhook to add in Track, whose secret comes back here.
 */
export function TrackWorkDialog({
	available,
	sandboxOffer,
	onClose,
}: {
	available: ModelProvider[];
	sandboxOffer: SandboxOffer;
	onClose: () => void;
}) {
	const [made, setMade] = useState<TrackWorkSetUp | null>(null);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				{made ? (
					<TrackWebhookStep
						made={made}
						done={`${made.agentName} will work on the issues assigned to ${made.memberName}`}
						onClose={onClose}
					>
						{made.agentName} is ready. In Track, open Settings → Webhooks and add a webhook with
						this URL. Under Events, choose Issue created and Issue updated; the trigger skips issues
						that are not just assigned to {made.memberName}. Under For agent, choose{" "}
						{made.memberName}, so that its own changes do not come back to it. Then assign it an
						issue.
					</TrackWebhookStep>
				) : (
					<SetUpStep
						available={available}
						sandboxOffer={sandboxOffer}
						onMade={setMade}
						onClose={onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function SetUpStep({
	available,
	sandboxOffer,
	onMade,
	onClose,
}: {
	available: ModelProvider[];
	sandboxOffer: SandboxOffer;
	onMade: (made: TrackWorkSetUp) => void;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const startEngine = firstEngine(available);
	const startProvider =
		providersOf(startEngine).find((provider) => available.includes(provider)) ?? "anthropic";
	const [trackUrl, setTrackUrl] = useState(GATEWEAVE_TRACK);
	const [agentKey, setAgentKey] = useState("");
	const [engine, setEngine] = useState<AgentEngine>(startEngine);
	const [provider, setProvider] = useState<ModelProvider>(startProvider);
	const [model, setModel] = useState(SUGGESTED_MODELS[startProvider] ?? "");
	// The repositories the workspace's GitHub App reaches, which the sandbox can check out.
	const [repositories, setRepositories] = useState<Repository[] | null>(null);
	const [repositoryId, setRepositoryId] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const providers = providersOf(engine);

	useEffect(() => {
		let live = true;
		getRepositories({ data: slug })
			.then((found) => {
				if (!live) return;
				const reachable = (found ?? []).filter(
					(repository) => repository.provider === "github" && repository.installationId !== null,
				);
				setRepositories(reachable);
				setRepositoryId((current) => current || (reachable[0]?.id ?? ""));
			})
			.catch(() => {
				if (live) setRepositories([]);
			});
		return () => {
			live = false;
		};
	}, [slug]);

	function chooseProvider(next: ModelProvider) {
		setProvider(next);
		setModel(SUGGESTED_MODELS[next] ?? "");
	}

	function chooseEngine(next: AgentEngine) {
		setEngine(next);
		// An engine calls only its providers' models, so the provider follows it when it must.
		const allowed = providersOf(next);
		if (!allowed.includes(provider)) {
			chooseProvider(
				allowed.find((option) => available.includes(option)) ?? allowed[0] ?? provider,
			);
		}
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			onMade(
				await setUpTrackWork({
					data: {
						slug,
						work: { trackUrl, agentKey: agentKey.trim(), provider, model, engine, repositoryId },
					},
				}),
			);
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	if (sandboxOffer !== "offered") {
		return (
			<div className="space-y-4">
				<DialogHeader>
					<DialogTitle>Work on Track issues</DialogTitle>
					<DialogDescription>
						This agent works in a sandbox, which{" "}
						{sandboxOffer === "by-invitation"
							? "this server offers only to the workspaces it invites."
							: "this server does not run."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Close
					</Button>
				</DialogFooter>
			</div>
		);
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<DialogHeader>
				<DialogTitle>Work on Track issues</DialogTitle>
				<DialogDescription>
					An agent member of your Track workspace that takes the issues assigned to it: it works on
					each in a sandbox with your repository checked out, opens a pull request, and comments on
					the issue as it starts and when it is done. In Track it can read the workspace and its
					issues, comment, and move an issue along, nothing more.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-2">
				<Label htmlFor="work-track-url">Track</Label>
				<Input
					id="work-track-url"
					type="url"
					value={trackUrl}
					onChange={(event) => setTrackUrl(event.target.value)}
					maxLength={2000}
					required
				/>
				<p className="text-xs text-muted-foreground">Track's address. Any page of it will do.</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="work-agent-key">Agent key</Label>
				<Input
					id="work-agent-key"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={agentKey}
					onChange={(event) => setAgentKey(event.target.value)}
					placeholder="gwt_…"
					maxLength={200}
					required
				/>
				<p className="text-xs text-muted-foreground">
					In Track, create an agent under Settings → Agents and copy the key it shows. Issues
					assigned to that agent come here. The key is kept encrypted, and checked with Track before
					anything is made.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="work-repository">Repository</Label>
				<select
					id="work-repository"
					value={repositoryId}
					onChange={(event) => setRepositoryId(event.target.value)}
					className={SELECT}
					disabled={!repositories || repositories.length === 0}
					required
				>
					{repositories === null && <option value="">Loading…</option>}
					{repositories?.length === 0 && <option value="">No repository yet</option>}
					{repositories?.map((repository) => (
						<option key={repository.id} value={repository.id}>
							{repository.owner}/{repository.name}
						</option>
					))}
				</select>
				<p className="text-xs text-muted-foreground">
					Where it works and opens pull requests: a repository the workspace's GitHub App reaches.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="work-engine">Engine</Label>
				<select
					id="work-engine"
					value={engine}
					onChange={(event) => chooseEngine(event.target.value as AgentEngine)}
					className={SELECT}
				>
					{AGENT_ENGINES.map((option) => (
						<option key={option} value={option}>
							{ENGINE_NAMES[option]}
						</option>
					))}
				</select>
				<p className="text-xs text-muted-foreground">
					A vendor's coding agent reads the repository's own guidance, such as CLAUDE.md or
					AGENTS.md.
				</p>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-2">
					<Label htmlFor="work-provider">Provider</Label>
					<select
						id="work-provider"
						value={provider}
						onChange={(event) => chooseProvider(event.target.value as ModelProvider)}
						className={SELECT}
					>
						{providers.map((option) => (
							<option key={option} value={option}>
								{MODEL_PROVIDER_NAMES[option]}
								{available.includes(option) ? "" : providerPickerNote(option)}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="work-model">Model</Label>
					<Input
						id="work-model"
						value={model}
						onChange={(event) => setModel(event.target.value)}
						spellCheck={false}
						maxLength={200}
						className="font-mono text-xs"
						required
					/>
				</div>
			</div>
			{!available.includes(provider) && (
				<p className="text-xs text-amber-600 dark:text-amber-500">
					{providerMissing(provider)}
					{isKeyedProvider(provider)
						? " yet, so the agent cannot answer until an owner or admin adds one in Settings."
						: ", so the agent cannot answer until whoever runs the server turns it on."}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<DialogFooter className="gap-2">
				<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={pending || !agentKey.trim() || !model.trim() || repositoryId === ""}
				>
					{pending ? "Checking with Track…" : "Set up"}
				</Button>
			</DialogFooter>
		</form>
	);
}
