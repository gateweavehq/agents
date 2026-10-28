import type { AssetFile } from "@gateweave/agents-model";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { useWorkspace } from "#/components/workspace/context";
import { editLibraryAsset } from "#/lib/registry";

/**
 * Edits the text of a library asset's files and saves it as the next version. Files whose text is
 * not kept are not shown here; they stay as they are.
 */
export function EditFiles({
	assetId,
	version,
	files,
	onClose,
}: {
	assetId: string;
	version: number;
	files: AssetFile[];
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const editable = files.filter((file) => file.content !== null);
	const [drafts, setDrafts] = useState(
		() => new Map(editable.map((file) => [file.path, file.content ?? ""])),
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setPending(true);
		setError(null);
		try {
			const changed = editable
				.filter((file) => drafts.get(file.path) !== file.content)
				.map((file) => ({ path: file.path, content: drafts.get(file.path) ?? "" }));
			if (changed.length === 0) {
				toast.message("Nothing changed");
				onClose();
				return;
			}
			const saved = await editLibraryAsset({
				data: { slug, edit: { libraryAssetId: assetId, files: changed } },
			});
			toast.success(saved === version ? "Nothing changed" : `Saved as version ${saved}`);
			await router.invalidate();
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Something went wrong");
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="space-y-3">
			{editable.map((file) => (
				<div key={file.path} className="space-y-1.5">
					<label htmlFor={`file-${file.path}`} className="block font-mono text-xs">
						{file.path}
					</label>
					<Textarea
						id={`file-${file.path}`}
						value={drafts.get(file.path) ?? ""}
						onChange={(event) =>
							setDrafts((previous) => new Map(previous).set(file.path, event.target.value))
						}
						className="min-h-64 font-mono text-xs leading-relaxed"
						spellCheck={false}
					/>
				</div>
			))}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<Button size="sm" onClick={save} disabled={pending}>
					Save as next version
				</Button>
				<Button size="sm" variant="outline" onClick={onClose} disabled={pending}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
