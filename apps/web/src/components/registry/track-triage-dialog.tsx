import { MODEL_PROVIDER_NAMES, MODEL_PROVIDERS, type ModelProvider } from "@gateweave/agents-model";
import { useNavigate } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
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
import { replaceTriggerSecret } from "#/lib/triggers";

/** Where Gateweave Cloud's Track is, which most people triage. */
const GATEWEAVE_TRACK = "https://track.gateweave.com";

/** A model to start from for each provider: triage is short work, so a fast one. */
const SUGGESTED_MODELS: Partial<Record<ModelProvider, string>> = {
	anthropic: "claude-haiku-5-5",
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
	keyed,
	onClose,
}: {
	keyed: ModelProvider[];
	onClose: () => void;
}) {
	const [made, setMade] = useState<TrackTriageSetUp | null>(null);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				{made ? (
					<WebhookStep made={made} onClose={onClose} />
				) : (
					<SetUpStep keyed={keyed} onMade={setMade} onClose={onClose} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function SetUpStep({
	keyed,
	onMade,
	onClose,
}: {
	keyed: ModelProvider[];
	onMade: (made: TrackTriageSetUp) => void;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const first = MODEL_PROVIDERS.find((provider) => keyed.includes(provider)) ?? "anthropic";
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
				<p className="text-xs text-muted-foreground">
					Where you open Track, without the workspace.
				</p>
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
					In Track, add an agent under Settings → Agents, then make a key for it with New key. It is
					kept encrypted, and checked with Track before anything is made.
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
								{keyed.includes(option) ? "" : " (no key)"}
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
			{!keyed.includes(provider) && (
				<p className="text-xs text-amber-600 dark:text-amber-500">
					The workspace has no {MODEL_PROVIDER_NAMES[provider]} key yet, so the agent cannot answer
					until an owner or admin adds one in Settings.
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

/** The webhook to add in Track, and the secret Track shows for it, which the trigger then checks. */
function WebhookStep({ made, onClose }: { made: TrackTriageSetUp; onClose: () => void }) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const [secret, setSecret] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function openAgent() {
		onClose();
		await navigate({
			to: "/$workspace/agents/$agentId",
			params: { workspace: slug, agentId: made.agentId },
		});
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await replaceTriggerSecret({
				data: { slug, triggerId: made.triggerId, secret: secret.trim() },
			});
			toast.success(`${made.agentName} will triage each new issue`);
			await openAgent();
		} catch (failure) {
			setError(message(failure));
			setPending(false);
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(made.url);
			toast.success("URL copied");
		} catch {
			toast.error("Could not copy; select it and copy it yourself");
		}
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<DialogHeader>
				<DialogTitle>Now tell Track</DialogTitle>
				<DialogDescription>
					{made.agentName} is ready. In Track, open Settings → Webhooks and add a webhook with this
					URL, the event Issue created, and your agent under For agent, so that its own changes do
					not come back to it.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-2">
				<Label htmlFor="triage-webhook-url">URL</Label>
				<div className="flex gap-2">
					<Input
						id="triage-webhook-url"
						value={made.url}
						readOnly
						onFocus={(event) => event.target.select()}
						className="font-mono text-xs"
					/>
					<Button
						type="button"
						variant="outline"
						size="icon"
						aria-label="Copy the URL"
						onClick={copy}
					>
						<Copy />
					</Button>
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="triage-webhook-secret">The webhook's secret</Label>
				<Input
					id="triage-webhook-secret"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					placeholder="whsec_…"
					maxLength={200}
					required
				/>
				<p className="text-xs text-muted-foreground">
					Track shows it once, when the webhook is added. Until it is here, deliveries are refused.
					You can also paste it later on the agent's page, under Triggers.
				</p>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<DialogFooter className="gap-2">
				<Button type="button" variant="outline" onClick={openAgent} disabled={pending}>
					Later
				</Button>
				<Button type="submit" disabled={pending || !secret.trim()}>
					{pending ? "Saving…" : "Save and finish"}
				</Button>
			</DialogFooter>
		</form>
	);
}
