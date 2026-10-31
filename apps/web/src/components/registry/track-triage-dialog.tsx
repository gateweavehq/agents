import {
	isKeyedProvider,
	MODEL_PROVIDER_NAMES,
	MODEL_PROVIDERS,
	type ModelProvider,
	providerMissing,
	providerPickerNote,
} from "@gateweave/agents-model";
import { type FormEvent, useState } from "react";
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
import { setUpTrackTriage, type TrackTriageSetUp } from "#/lib/track-triage";

/** Where Gateweave Cloud's Track is, which most people triage. */
const GATEWEAVE_TRACK = "https://track.gateweave.com";

/** A model to start from for each provider: triage is short work, so a fast one. */
const SUGGESTED_MODELS: Partial<Record<ModelProvider, string>> = {
	anthropic: "claude-haiku-5-5",
	"workers-ai": "@cf/meta/llama-4-scout-17b-16e-instruct",
};

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * Sets up Track triage: first the Track URL, the agent member's key and the model, which make the
 * agent and its trigger; then the webhook to add in Track, whose secret comes back here.
 */
export function TrackTriageDialog({
	available,
	onClose,
}: {
	available: ModelProvider[];
	onClose: () => void;
}) {
	const [made, setMade] = useState<TrackTriageSetUp | null>(null);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				{made ? (
					<TrackWebhookStep
						made={made}
						done={`${made.agentName} will triage each new issue`}
						onClose={onClose}
					>
						{made.agentName} is ready. In Track, open Settings → Webhooks and add a webhook with
						this URL. Under Events, Issue created is all triage needs; the trigger skips the others.
						Under For agent, choose your agent, so that its own changes do not come back to it.
					</TrackWebhookStep>
				) : (
					<SetUpStep available={available} onMade={setMade} onClose={onClose} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function SetUpStep({
	available,
	onMade,
	onClose,
}: {
	available: ModelProvider[];
	onMade: (made: TrackTriageSetUp) => void;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const first = MODEL_PROVIDERS.find((provider) => available.includes(provider)) ?? "anthropic";
	const [trackUrl, setTrackUrl] = useState(GATEWEAVE_TRACK);
	const [agentKey, setAgentKey] = useState("");
	const [provider, setProvider] = useState<ModelProvider>(first);
	const [model, setModel] = useState(SUGGESTED_MODELS[first] ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function choose(next: ModelProvider) {
		setProvider(next);
		setModel(SUGGESTED_MODELS[next] ?? "");
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			onMade(
				await setUpTrackTriage({
					data: { slug, triage: { trackUrl, agentKey: agentKey.trim(), provider, model } },
				}),
			);
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<DialogHeader>
				<DialogTitle>Triage Track issues</DialogTitle>
				<DialogDescription>
					An agent that labels, prioritizes and comments on each new issue, as an agent member of
					your Track workspace. It gets only the tools triage needs: reading the workspace and its
					issues, changing an issue's labels and priority, and commenting.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-2">
				<Label htmlFor="triage-track-url">Track</Label>
				<Input
					id="triage-track-url"
					type="url"
					value={trackUrl}
					onChange={(event) => setTrackUrl(event.target.value)}
					maxLength={2000}
					required
				/>
				<p className="text-xs text-muted-foreground">Track's address. Any page of it will do.</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="triage-agent-key">Agent key</Label>
				<Input
					id="triage-agent-key"
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
					In Track, create an agent under Settings → Agents and copy the key it shows. It is kept
					encrypted, and checked with Track before anything is made.
				</p>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-2">
					<Label htmlFor="triage-provider">Provider</Label>
					<select
						id="triage-provider"
						value={provider}
						onChange={(event) => choose(event.target.value as ModelProvider)}
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
					<Label htmlFor="triage-model">Model</Label>
					<Input
						id="triage-model"
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
				<Button type="submit" disabled={pending || !agentKey.trim() || !model.trim()}>
					{pending ? "Checking with Track…" : "Set up"}
				</Button>
			</DialogFooter>
		</form>
	);
}
