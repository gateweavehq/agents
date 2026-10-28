import {
	type ApplyOutcome,
	ASSET_KIND_NAMES,
	ASSET_KINDS,
	type LibraryEntry,
	REPOSITORY_RUNTIMES,
	type Repository,
	type RepositoryRuntime,
	RUNTIME_NAMES,
	type Setup,
	type SetupAsset,
	type SetupInput,
	type SetupPins,
} from "@gateweave/agents-model";
import { type FormEvent, useState } from "react";
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

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/** Names a new setup and chooses its coding agents, or changes `setup`. */
export function SetupDialog({
	setup,
	onSave,
	onClose,
}: {
	setup?: Setup;
	onSave: (input: SetupInput) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(setup?.name ?? "");
	const [description, setDescription] = useState(setup?.description ?? "");
	const [runtimes, setRuntimes] = useState<Set<RepositoryRuntime>>(
		() => new Set(setup?.runtimes ?? REPOSITORY_RUNTIMES),
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggle(runtime: RepositoryRuntime, on: boolean) {
		setRuntimes((current) => {
			const next = new Set(current);
			if (on) next.add(runtime);
			else next.delete(runtime);
			return next;
		});
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave({
				name: name.trim(),
				description: description.trim() || null,
				runtimes: REPOSITORY_RUNTIMES.filter((runtime) => runtimes.has(runtime)),
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
						<DialogTitle>{setup ? "Edit setup" : "New setup"}</DialogTitle>
						<DialogDescription>
							A setup is a set of library assets, each pinned to a version, written in the format of
							every coding agent it configures.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="setup-name">Name</Label>
						<Input
							id="setup-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							autoFocus
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="setup-description">Description</Label>
						<Textarea
							id="setup-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							maxLength={2000}
							rows={3}
						/>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Coding agents</legend>
						<div className="grid grid-cols-2 gap-2">
							{REPOSITORY_RUNTIMES.map((runtime) => (
								<Label key={runtime} className="flex items-center gap-2 font-normal">
									<Checkbox
										checked={runtimes.has(runtime)}
										onCheckedChange={(checked) => toggle(runtime, checked === true)}
									/>
									{RUNTIME_NAMES[runtime]}
								</Label>
							))}
						</div>
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
						<Button type="submit" disabled={pending || !name.trim() || runtimes.size === 0}>
							{setup ? "Save" : "Create setup"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Chooses a setup's library assets. An asset already pinned keeps its version; one added is
 * pinned to its latest. An asset that has left the library shows only while it is pinned.
 */
export function SetupAssetsDialog({
	setup,
	pinned,
	library,
	onSave,
	onClose,
}: {
	setup: Setup;
	pinned: SetupAsset[];
	library: LibraryEntry[];
	onSave: (pins: SetupPins) => Promise<void>;
	onClose: () => void;
}) {
	const versions = new Map(pinned.map((pin) => [pin.asset.id, pin.version]));
	const left = pinned.filter((pin) => pin.removed).map((pin) => pin.asset);
	const choices = [...left, ...library.map((entry) => entry.asset)];
	const [chosen, setChosen] = useState(() => new Set(versions.keys()));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggle(id: string, on: boolean) {
		setChosen((current) => {
			const next = new Set(current);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	}

	async function save() {
		setPending(true);
		setError(null);
		try {
			await onSave(
				choices
					.filter((asset) => chosen.has(asset.id))
					.map((asset) => ({
						assetId: asset.id,
						version: versions.get(asset.id) ?? asset.version,
					})),
			);
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
				<DialogHeader>
					<DialogTitle>Assets in {setup.name}</DialogTitle>
					<DialogDescription>
						{choices.length === 0
							? "The library is empty. Add assets to it from a repository first."
							: "New assets are pinned to their latest version. Pinned ones keep theirs."}
					</DialogDescription>
				</DialogHeader>
				{choices.length > 0 && (
					<div className="max-h-96 space-y-4 overflow-y-auto">
						{ASSET_KINDS.map((kind) => {
							const ofKind = choices.filter((asset) => asset.kind === kind);
							if (ofKind.length === 0) return null;
							return (
								<section key={kind} aria-label={ASSET_KIND_NAMES[kind]} className="space-y-1.5">
									<h3 className="text-xs text-muted-foreground">{ASSET_KIND_NAMES[kind]}</h3>
									<ul className="divide-y rounded-lg border">
										{ofKind.map((asset) => (
											<li key={asset.id}>
												<Label className="flex cursor-pointer items-center gap-3 p-3 font-normal hover:bg-accent/50">
													<Checkbox
														checked={chosen.has(asset.id)}
														onCheckedChange={(checked) => toggle(asset.id, checked === true)}
													/>
													<span className="min-w-0 flex-1 truncate">{asset.name}</span>
													<span className="text-xs text-muted-foreground tabular-nums">
														v{versions.get(asset.id) ?? asset.version}
														{left.includes(asset) && ", left the library"}
													</span>
												</Label>
											</li>
										))}
									</ul>
								</section>
							);
						})}
					</div>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<DialogFooter className="gap-2">
					<Button variant="outline" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button onClick={save} disabled={pending || choices.length === 0}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Applies a setup to one repository: a pull request that writes its files there, or a new
 * commit on the one still open. What happened stays in the dialog, with any file left alone.
 */
export function ApplySetupDialog({
	setup,
	repositories,
	openIn,
	onApply,
	onClose,
}: {
	setup: Setup;
	/** Repositories the GitHub App reaches. */
	repositories: Repository[];
	/** Repositories with a pull request for this setup still open, by id. */
	openIn: ReadonlySet<string>;
	onApply: (repositoryId: string) => Promise<ApplyOutcome>;
	onClose: () => void;
}) {
	const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
	const repository = repositories.find((candidate) => candidate.id === repositoryId);
	const name = repository ? `${repository.owner}/${repository.name}` : "";

	async function apply(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			setOutcome(await onApply(repositoryId));
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={apply} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Apply {setup.name}</DialogTitle>
						<DialogDescription>
							Opens a pull request that writes the setup's files. Nothing reaches the default branch
							until someone merges it, and files the setup does not write stay as they are.
						</DialogDescription>
					</DialogHeader>
					{repositories.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No repository is connected through the GitHub App yet.
						</p>
					) : (
						<div className="space-y-2">
							<Label htmlFor="apply-repository">Repository</Label>
							<select
								id="apply-repository"
								value={repositoryId}
								onChange={(event) => {
									setRepositoryId(event.target.value);
									setOutcome(null);
									setError(null);
								}}
								disabled={pending}
								className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
							>
								{repositories.map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.owner}/{candidate.name}
									</option>
								))}
							</select>
						</div>
					)}
					{outcome && <ApplyResult outcome={outcome} repository={name} />}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							{outcome ? "Done" : "Cancel"}
						</Button>
						{!outcome && (
							<Button type="submit" disabled={pending || !repository}>
								{openIn.has(repositoryId) ? "Update pull request" : "Open pull request"}
							</Button>
						)}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function ApplyResult({ outcome, repository }: { outcome: ApplyOutcome; repository: string }) {
	const { application, problems } = outcome;
	return (
		<div role="status" className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
			<p>
				{outcome.status === "unchanged" || !application ? (
					`${repository} already has every file this setup writes.`
				) : (
					<>
						{outcome.status === "opened" ? "Opened " : outcome.status === "updated" ? "Gave " : ""}
						<a
							href={application.pullUrl}
							target="_blank"
							rel="noreferrer"
							className="font-medium underline underline-offset-2"
						>
							{outcome.status === "current" ? "Pull request" : "pull request"} #
							{application.pullNumber}
						</a>
						{outcome.status === "opened"
							? ` in ${repository}.`
							: outcome.status === "updated"
								? ` in ${repository} a new commit.`
								: ` in ${repository} already writes these files.`}
					</>
				)}
			</p>
			{problems.length > 0 && (
				<div className="space-y-1">
					<p className="text-muted-foreground">Left alone:</p>
					<ul className="space-y-1">
						{problems.map((problem) => (
							<li key={problem.path}>
								<span className="font-mono text-xs">{problem.path}</span>
								<span className="text-muted-foreground"> · {problem.message}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
