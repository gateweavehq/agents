import {
	AGENT_ENGINES,
	type AgentEngine,
	ENGINE_NAMES,
	isKeyedProvider,
	MODEL_PROVIDER_NAMES,
	type ModelProvider,
	providerMissing,
	providerPickerNote,
	type Repository,
	type ReviewGatePass,
	reviewGateLine,
	type SandboxOffer,
} from "@gateweave/agents-model";
import { type FormEvent, useEffect, useState } from "react";
import { providersOf } from "#/components/registry/track-connect-step";
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
import { setUpPullRequestReview } from "#/lib/pull-request-review";
import { getRepositories } from "#/lib/registry";

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";
const SUGGESTED_MODELS: Partial<Record<ModelProvider, string>> = {
	anthropic: "claude-sonnet-5-5",
	openai: "gpt-5.5",
	"workers-ai": "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
};

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/** Sets up the ready-made reviewer once the replay gate has passed. */
export function PullRequestReviewDialog({
	available,
	sandboxOffer,
	gate,
	onClose,
}: {
	available: ModelProvider[];
	sandboxOffer: SandboxOffer;
	gate: ReviewGatePass;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const [engine, setEngine] = useState<AgentEngine>("gateweave");
	const providers = providersOf(engine);
	const [provider, setProvider] = useState<ModelProvider>(
		providers.find((option) => available.includes(option)) ?? providers[0] ?? "anthropic",
	);
	const [model, setModel] = useState(SUGGESTED_MODELS[provider] ?? "");
	const [repositories, setRepositories] = useState<Repository[] | null>(null);
	const [repositoryId, setRepositoryId] = useState("");
	const [pending, setPending] = useState(false);
	const [done, setDone] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

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
			const made = await setUpPullRequestReview({
				data: { slug, review: { provider, model, engine, repositoryId } },
			});
			setDone(made.agentName);
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				{sandboxOffer !== "offered" ? (
					<div className="space-y-4">
						<DialogHeader>
							<DialogTitle>Review pull requests</DialogTitle>
							<DialogDescription>
								This agent reviews in a sandbox, which{" "}
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
				) : done ? (
					<div className="space-y-4">
						<DialogHeader>
							<DialogTitle>Review pull requests</DialogTitle>
							<DialogDescription>
								{done} is ready. It reviews pull requests this workspace's agents open in the chosen
								repository, as a second reader, never the approval.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button type="button" onClick={onClose}>
								Done
							</Button>
						</DialogFooter>
					</div>
				) : (
					<form onSubmit={onSubmit} className="space-y-4">
						<DialogHeader>
							<DialogTitle>Review pull requests</DialogTitle>
							<DialogDescription>
								A reviewer of pull requests this workspace's agents open in one repository: a second
								reader, never the approval. It runs with memory off, reviews up to 30 pull requests
								a day, and its runs are paid with the workspace's provider key and sandbox minutes.
							</DialogDescription>
						</DialogHeader>
						<p className="rounded-md border p-3 text-sm text-muted-foreground">
							{reviewGateLine(gate)}
						</p>
						<div className="space-y-2">
							<Label htmlFor="review-repository">Repository</Label>
							<select
								id="review-repository"
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
								Only pull requests this workspace's agents open in this repository are reviewed.
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="review-engine">Engine</Label>
							<select
								id="review-engine"
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
								Reviews use Gateweave's review tool; an engine that cannot use it is refused when
								the setup is checked.
							</p>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="review-provider">Provider</Label>
								<select
									id="review-provider"
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
								<Label htmlFor="review-model">Model</Label>
								<Input
									id="review-model"
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
							<Button type="submit" disabled={pending || !model.trim() || repositoryId === ""}>
								{pending ? "Setting up…" : "Set up"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
