import {
	AGENT_ENGINES,
	type AgentEngine,
	ENGINE_NAMES,
	ENGINE_PROVIDERS,
	isKeyedProvider,
	MODEL_PROVIDER_NAMES,
	MODEL_PROVIDERS,
	type ModelProvider,
	type ProviderModel,
	providerMissing,
	providerPickerNote,
	type Repository,
	type TrackConnectPurpose,
} from "@gateweave/agents-model";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { DialogFooter } from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { useWorkspace } from "#/components/workspace/context";
import { getModels, getRepositories } from "#/lib/registry";
import { beginTrackConnect } from "#/lib/track-connect";

/** Where Gateweave Cloud's Track is, which most people use. */
export const GATEWEAVE_TRACK = "https://track.gateweave.com";

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";
const OTHER = "\u0000other";

/** A model to start from for each provider, if the provider lists it: coding takes a capable one, triage a fast one. */
const SUGGESTED_MODELS: Record<TrackConnectPurpose, Partial<Record<ModelProvider, string>>> = {
	work: { anthropic: "claude-sonnet-5-5", openai: "gpt-5.5" },
	triage: {
		anthropic: "claude-haiku-5-5",
		"workers-ai": "@cf/meta/llama-4-scout-17b-16e-instruct",
	},
};

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/** The engine to start from: a vendor's coding agent the workspace has a key for, if any. */
export function firstEngine(available: ModelProvider[]): AgentEngine {
	for (const engine of ["claude-code", "codex", "opencode"] as const) {
		if (ENGINE_PROVIDERS[engine].some((provider) => available.includes(provider))) return engine;
	}
	return "gateweave";
}

/** The providers an engine calls; Gateweave's own loop calls any. */
export function providersOf(engine: AgentEngine): readonly ModelProvider[] {
	return engine === "gateweave" ? MODEL_PROVIDERS : ENGINE_PROVIDERS[engine];
}

/** The providers the workspace can use first, so the first one is the one that works. */
function usableFirst(providers: readonly ModelProvider[], available: ModelProvider[]) {
	return [...providers].sort(
		(a, b) => Number(available.includes(b)) - Number(available.includes(a)),
	);
}

/**
 * The one step of connecting Track: what the agent is, then to Track to approve it, which makes
 * the agent member and its webhook there and brings their secrets back to the server, never to
 * this page. `onByHand` is the old way, for a Track that does not know this one.
 */
export function TrackConnectStep({
	purpose,
	available,
	onByHand,
	onClose,
}: {
	purpose: TrackConnectPurpose;
	available: ModelProvider[];
	onByHand: () => void;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const work = purpose === "work";
	const startEngine = work ? firstEngine(available) : "gateweave";
	const [trackUrl, setTrackUrl] = useState(GATEWEAVE_TRACK);
	const [engine, setEngine] = useState<AgentEngine>(startEngine);
	const providers = usableFirst(work ? providersOf(engine) : MODEL_PROVIDERS, available);
	const [provider, setProvider] = useState<ModelProvider>(providers[0] ?? "anthropic");
	const [model, setModel] = useState("");
	// The provider's models, or why there are none; null while they are asked for.
	const [models, setModels] = useState<ProviderModel[] | string | null>(null);
	const [typing, setTyping] = useState(false);
	// Whether the person typed a model while the list was asked for: what they typed stays.
	const typed = useRef(false);
	const [repositories, setRepositories] = useState<Repository[] | null>(null);
	const [repositoryId, setRepositoryId] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const usable = available.includes(provider);

	useEffect(() => {
		if (!work) return;
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
			.catch(() => live && setRepositories([]));
		return () => {
			live = false;
		};
	}, [slug, work]);

	useEffect(() => {
		setModels(null);
		setModel("");
		setTyping(false);
		typed.current = false;
		if (!usable) {
			setModels("No models to list without a key");
			return;
		}
		let live = true;
		getModels({ data: { slug, provider } })
			.then((found) => {
				if (!live) return;
				setModels(found);
				if (typed.current) {
					setTyping(true);
					return;
				}
				const wanted = SUGGESTED_MODELS[purpose][provider];
				const chosen = found.find((option) => option.id === wanted) ?? found[0];
				if (chosen) setModel(chosen.id);
				else setTyping(true);
			})
			.catch((failure) => {
				if (!live) return;
				setModels(message(failure));
				if (!typed.current) setModel(SUGGESTED_MODELS[purpose][provider] ?? "");
				setTyping(true);
			});
		return () => {
			live = false;
		};
	}, [slug, provider, usable, purpose]);

	// Coming back with the browser's back button shows this page as it was left, still waiting.
	useEffect(() => {
		const reset = (event: PageTransitionEvent) => event.persisted && setPending(false);
		window.addEventListener("pageshow", reset);
		return () => window.removeEventListener("pageshow", reset);
	}, []);

	// Closing the dialog while the server is asked calls the trip to Track off.
	const shown = useRef(true);
	useEffect(() => {
		shown.current = true;
		return () => {
			shown.current = false;
		};
	}, []);

	function chooseEngine(next: AgentEngine) {
		setEngine(next);
		const allowed = usableFirst(providersOf(next), available);
		if (!allowed.includes(provider)) setProvider(allowed[0] ?? provider);
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			const address = await beginTrackConnect({
				data: {
					slug,
					connect: work
						? { purpose, trackUrl, provider, model, engine, repositoryId }
						: { purpose, trackUrl, provider, model },
				},
			});
			if (!shown.current) return;
			// Away to Track, which brings the person back to this server when they have decided.
			window.location.assign(address);
		} catch (failure) {
			if (!shown.current) return;
			setError(message(failure));
			setPending(false);
		}
	}

	const list = Array.isArray(models) ? models : [];
	const ready = model.trim() !== "" && (!work || repositoryId !== "");

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			{work && (
				<div className="space-y-2">
					<Label htmlFor={`${purpose}-repository`}>Repository</Label>
					<select
						id={`${purpose}-repository`}
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
			)}
			{work && (
				<div className="space-y-2">
					<Label htmlFor="connect-engine">Engine</Label>
					<select
						id="connect-engine"
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
			)}
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-2">
					<Label htmlFor="connect-provider">Provider</Label>
					<select
						id="connect-provider"
						value={provider}
						onChange={(event) => setProvider(event.target.value as ModelProvider)}
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
					<Label htmlFor="connect-model">Model</Label>
					{typing || list.length === 0 ? (
						<Input
							id="connect-model"
							value={model}
							onChange={(event) => {
								typed.current = true;
								setModel(event.target.value);
							}}
							placeholder={models === null ? "Asking for the models…" : "A model's id"}
							spellCheck={false}
							maxLength={200}
							className="font-mono text-xs"
							required
						/>
					) : (
						<select
							id="connect-model"
							value={model}
							onChange={(event) => {
								if (event.target.value === OTHER) {
									setTyping(true);
									setModel("");
								} else setModel(event.target.value);
							}}
							className={SELECT}
						>
							{list.map((option) => (
								<option key={option.id} value={option.id}>
									{option.name}
								</option>
							))}
							<option value={OTHER}>Other…</option>
						</select>
					)}
				</div>
			</div>
			{!usable && (
				<p className="text-xs text-amber-600 dark:text-amber-500">
					{providerMissing(provider)}
					{isKeyedProvider(provider)
						? ", so there is nothing to connect it to yet: an owner or admin adds one in Settings."
						: "."}
				</p>
			)}
			{typeof models === "string" && usable && (
				<p className="text-xs text-muted-foreground">{models}. Type the model's id instead.</p>
			)}
			<details className="text-sm">
				<summary className="cursor-pointer text-muted-foreground">Another Track</summary>
				<div className="mt-2 space-y-2">
					<Label htmlFor={`${purpose}-track-url`}>Track</Label>
					<Input
						id={`${purpose}-track-url`}
						type="url"
						value={trackUrl}
						onChange={(event) => setTrackUrl(event.target.value)}
						maxLength={2000}
						required
					/>
					<p className="text-xs text-muted-foreground">
						The address of a Track you run. It is sent this server's address to post webhooks to, so
						use one you trust.
					</p>
				</div>
			</details>
			<p className="text-xs text-muted-foreground">
				You will approve it in Track, where you choose the workspace and the team. Nothing is made
				until you do, and no key or secret is shown or copied: Track hands them to this server.
			</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<DialogFooter className="gap-2 sm:justify-between">
				<Button type="button" variant="link" className="px-0" onClick={onByHand} disabled={pending}>
					Set it up by hand
				</Button>
				<div className="flex gap-2">
					<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button type="submit" disabled={pending || !ready || !usable}>
						{pending ? "Going to Track…" : "Connect Track"}
					</Button>
				</div>
			</DialogFooter>
		</form>
	);
}
