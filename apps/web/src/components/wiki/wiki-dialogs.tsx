import {
	type KeyedProvider,
	MODEL_PROVIDER_NAMES,
	type ProviderModel,
	type WikiEntry,
	type WikiGeneration,
} from "@gateweave/agents-model";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
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
import { formatRelative } from "#/lib/dates";
import { getProviderKeys } from "#/lib/providers";
import { getModels } from "#/lib/registry";
import { formatCost } from "#/lib/usage";
import { startWiki } from "#/lib/wiki";

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

/** Whether a generation is still being written. */
export function underway(generation: WikiGeneration | null): boolean {
	return generation?.status === "planning" || generation?.status === "writing";
}

/** How the repository's wiki stands, in one line. */
export function WikiStatus({ entry }: { entry: WikiEntry }) {
	const { live, latest } = entry;
	if (latest && underway(latest)) {
		return (
			<span className="text-xs text-muted-foreground">
				{latest.status === "planning"
					? "Planning the pages…"
					: `Writing page ${Math.min(latest.pagesDone + 1, latest.pagesTotal)} of ${latest.pagesTotal}…`}
			</span>
		);
	}
	if (latest?.status === "failed") {
		return (
			<span className="text-xs text-destructive" title={latest.error ?? undefined}>
				{live ? "The last rewrite failed" : "Writing it failed"}
			</span>
		);
	}
	if (live) {
		return (
			<span className="text-xs text-muted-foreground">
				{live.pagesTotal === 1 ? "1 page" : `${live.pagesTotal} pages`}
				{live.finishedAt !== null && `, ${formatRelative(live.finishedAt)}`}
			</span>
		);
	}
	return <span className="text-xs text-muted-foreground">No wiki yet</span>;
}

/** What a written wiki was written from, by which model, and what it cost. */
export function WikiProvenance({ generation }: { generation: WikiGeneration }) {
	const { commit, provider, model, cost, tokens } = generation;
	return (
		<span>
			{commit && <span className="font-mono">{commit.slice(0, 7)}</span>}
			{" · "}
			{MODEL_PROVIDER_NAMES[provider]} {model}
			{" · "}
			{cost === null
				? `${(tokens.input + tokens.output).toLocaleString("en")} tokens`
				: `about ${formatCost(cost)}`}
			{generation.steered && " · pages from .devin/wiki.json"}
		</span>
	);
}

/**
 * Asks which model writes the wiki. It spends the workspace's key: every page is one request that
 * reads up to about 40,000 tokens of code.
 */
export function StartWikiDialog({
	slug,
	entry,
	onClose,
}: {
	slug: string;
	entry: WikiEntry;
	onClose: () => void;
}) {
	const router = useRouter();
	const [keyed, setKeyed] = useState<KeyedProvider[] | null>(null);
	const [provider, setProvider] = useState<KeyedProvider | "">(
		entry.live?.provider ?? entry.latest?.provider ?? "",
	);
	const [model, setModel] = useState(entry.live?.model ?? entry.latest?.model ?? "");
	const [models, setModels] = useState<ProviderModel[] | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		getProviderKeys({ data: slug })
			.then((found) => {
				if (!live) return;
				const providers = (found?.keys ?? []).map((key) => key.provider);
				setKeyed(providers);
				setProvider((current) =>
					current && providers.includes(current) ? current : (providers[0] ?? ""),
				);
			})
			.catch(() => live && setKeyed([]));
		return () => {
			live = false;
		};
	}, [slug]);

	useEffect(() => {
		setModels(null);
		if (!provider) return;
		let live = true;
		getModels({ data: { slug, provider } })
			.then((found) => live && setModels(found))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [slug, provider]);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!provider) return;
		setPending(true);
		setError(null);
		try {
			await startWiki({
				data: {
					slug,
					repositoryId: entry.repositoryId,
					choice: { provider, model: model.trim() },
				},
			});
			toast.success(`Writing the wiki of ${entry.owner}/${entry.name}`);
			await router.invalidate();
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>
							{entry.live ? "Write the wiki again" : "Write a wiki"} of {entry.owner}/{entry.name}
						</DialogTitle>
						<DialogDescription>
							A model reads the repository at its default branch, plans the pages (from
							.devin/wiki.json when the repository has one), then writes each page from the files it
							covers, citing their lines. It uses the workspace's key: each page is one request that
							reads up to about 40,000 tokens of code.
							{entry.live && " The wiki people read now stays until the new one is done."}
						</DialogDescription>
					</DialogHeader>
					{keyed !== null && keyed.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							The workspace has no key for Anthropic, OpenAI or Google yet. An owner or admin can
							add one in Settings, under Models.
						</p>
					) : (
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="wiki-provider">Provider</Label>
								<select
									id="wiki-provider"
									value={provider}
									onChange={(event) => {
										setProvider(event.target.value as KeyedProvider);
										setModel("");
									}}
									className={SELECT}
									disabled={keyed === null}
								>
									{(keyed ?? []).map((option) => (
										<option key={option} value={option}>
											{MODEL_PROVIDER_NAMES[option]}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="wiki-model">Model</Label>
								<Input
									id="wiki-model"
									list="wiki-models"
									value={model}
									onChange={(event) => setModel(event.target.value)}
									maxLength={200}
									spellCheck={false}
									autoComplete="off"
									required
								/>
								{models && (
									<datalist id="wiki-models">
										{models.map((option) => (
											<option key={option.id} value={option.id}>
												{option.name}
											</option>
										))}
									</datalist>
								)}
							</div>
						</div>
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
						<Button type="submit" disabled={pending || !provider || !model.trim()}>
							Write it
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
