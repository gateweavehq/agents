import type { Asset, LibraryEntry } from "@gateweave/agents-model";
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
import { useWorkspace } from "#/components/workspace/context";
import { addToLibrary, getLibrary } from "#/lib/registry";

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
