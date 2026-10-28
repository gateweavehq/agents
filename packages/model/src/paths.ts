import type { AssetKind } from "./vocabulary";

/**
 * Where one of an asset's files sits in its repository. Files are relative to the asset's
 * directory (see `scannedFile`): its `path` when it is a folder, such as a skill, and the path's
 * parent when it is a file, which shows as a single file named like the path. A plugin at the
 * repository root is the one exception: a path cannot be empty, so it keeps the path
 * `.claude-plugin`, and its files are relative to the root.
 */
export function repositoryPathOf(
	asset: { kind: AssetKind; path: string },
	files: readonly { path: string }[],
	file: { path: string },
): string {
	if (asset.kind === "plugin" && asset.path === ".claude-plugin") return file.path;
	const name = asset.path.slice(asset.path.lastIndexOf("/") + 1);
	if (files.length === 1 && file.path === name) return asset.path;
	return `${asset.path}/${file.path}`;
}
