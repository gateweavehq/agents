import {
	ASSET_KIND_NAMES,
	type Asset,
	type LibraryEntry,
	WRITTEN_ASSET_KINDS,
} from "@gateweave/agents-model";
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
import { addToLibrary, createLibraryAsset, getLibrary } from "#/lib/registry";

/**
 * Copies a repository asset into the library: as a new library asset, or as the next version of
 * one of the same kind. `onAdded` gets the library asset's id.
 */
export function AddToLibraryDialog({
	asset,
	onAdded,
	onClose,
}: {
	asset: Asset;
	onAdded: (libraryAssetId: string) => Promise<void>;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const [candidates, setCandidates] = useState<LibraryEntry[] | null>(null);
	const [mode, setMode] = useState<"new" | "version">("new");
	const [name, setName] = useState(asset.name);
	const [libraryAssetId, setLibraryAssetId] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		getLibrary({ data: slug })
			.then((library) => {
				if (!live) return;
				const ofKind = (library ?? []).filter((entry) => entry.asset.kind === asset.kind);
				setCandidates(ofKind);
				setLibraryAssetId(ofKind[0]?.asset.id ?? "");
			})
			.catch(() => live && setCandidates([]));
		return () => {
			live = false;
		};
	}, [slug, asset.kind]);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			const target = mode === "new" ? { name: name.trim() } : { libraryAssetId };
			const id = await addToLibrary({ data: { slug, assetId: asset.id, target } });
			await onAdded(id);
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Something went wrong");
		} finally {
			setPending(false);
		}
	}

	const canVersion = (candidates?.length ?? 0) > 0;
	const ready = mode === "new" ? name.trim() !== "" : libraryAssetId !== "";

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Add to library</DialogTitle>
						<DialogDescription>
							The library keeps a copy of this content as a version, and shows every repository that
							carries one of its versions.
						</DialogDescription>
					</DialogHeader>
					<fieldset className="space-y-3">
						<legend className="sr-only">Where it goes</legend>
						<Label className="flex items-start gap-2 font-normal">
							<input
								type="radio"
								name="mode"
								checked={mode === "new"}
								onChange={() => setMode("new")}
								className="mt-1"
							/>
							<span className="flex-1 space-y-2">
								<span className="block">As a new library asset</span>
								<Input
									aria-label="Name in the library"
									value={name}
									onChange={(event) => setName(event.target.value)}
									onFocus={() => setMode("new")}
									maxLength={200}
								/>
							</span>
						</Label>
						<Label className="flex items-start gap-2 font-normal">
							<input
								type="radio"
								name="mode"
								checked={mode === "version"}
								onChange={() => setMode("version")}
								disabled={!canVersion}
								className="mt-1"
							/>
							<span className="flex-1 space-y-2">
								<span className="block">As the next version of</span>
								{candidates === null ? (
									<span className="block text-xs text-muted-foreground">Loading the library…</span>
								) : canVersion ? (
									<select
										aria-label="Library asset"
										value={libraryAssetId}
										onChange={(event) => {
											setLibraryAssetId(event.target.value);
											setMode("version");
										}}
										className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
									>
										{candidates.map((entry) => (
											<option key={entry.asset.id} value={entry.asset.id}>
												{entry.asset.name} (v{entry.asset.version})
											</option>
										))}
									</select>
								) : (
									<span className="block text-xs text-muted-foreground">
										The library has no asset of this kind yet.
									</span>
								)}
							</span>
						</Label>
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
						<Button type="submit" disabled={pending || !ready}>
							Add to library
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const writtenHints = {
	instructions: "Instructions, as they would sit in an AGENTS.md",
	prompt: "A prompt or slash command",
	skill: "A SKILL.md, with name and description in its front matter",
} as const;

/** Writes a new library asset: a kind, a name and its text. `onCreated` gets its id. */
export function NewLibraryAssetDialog({
	onCreated,
	onClose,
}: {
	onCreated: (libraryAssetId: string) => Promise<void>;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const [kind, setKind] = useState<(typeof WRITTEN_ASSET_KINDS)[number]>("skill");
	const [name, setName] = useState("");
	const [text, setText] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			const id = await createLibraryAsset({
				data: { slug, asset: { kind, name: name.trim(), text } },
			});
			await onCreated(id);
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Something went wrong");
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-2xl">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>New library asset</DialogTitle>
						<DialogDescription>
							Write it here, without a repository. It starts as version 1, and every edit after it
							is the next version.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
						<div className="space-y-1.5">
							<Label htmlFor="new-asset-kind">Kind</Label>
							<select
								id="new-asset-kind"
								value={kind}
								onChange={(event) => {
									const next = WRITTEN_ASSET_KINDS.find((k) => k === event.target.value);
									if (next) setKind(next);
								}}
								className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
							>
								{WRITTEN_ASSET_KINDS.map((option) => (
									<option key={option} value={option}>
										{ASSET_KIND_NAMES[option]}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="new-asset-name">Name</Label>
							<Input
								id="new-asset-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={200}
							/>
						</div>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="new-asset-text">Text</Label>
						<Textarea
							id="new-asset-text"
							value={text}
							onChange={(event) => setText(event.target.value)}
							className="min-h-64 font-mono text-xs leading-relaxed"
							spellCheck={false}
						/>
						<p className="text-xs text-muted-foreground">{writtenHints[kind]}</p>
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
						<Button type="submit" disabled={pending || name.trim() === "" || text === ""}>
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
