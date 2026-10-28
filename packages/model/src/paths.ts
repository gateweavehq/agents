/**
 * Where one of an asset's files sits in its repository. Files are relative to the asset's
 * directory (see `scannedFile`): its `path` when it is a folder, such as a skill, and the path's
 * parent when it is a file, which shows as a single file named like the path.
 */
export function repositoryPathOf(
	asset: { path: string },
	files: readonly { path: string }[],
	file: { path: string },
): string {
	const name = asset.path.slice(asset.path.lastIndexOf("/") + 1);
	if (files.length === 1 && file.path === name) return asset.path;
	return `${asset.path}/${file.path}`;
}
