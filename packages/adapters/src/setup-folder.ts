/**
 * A setup kept as plain files: `setup.json` (see `setupManifest` in the model) and the files of
 * its assets. Ready-made setups ship this way, so contributors propose one as a folder, and the
 * CLI reads one from disk. Pure, so both read it the same way.
 */
import { type RepositoryRuntime, setupManifest } from "@gateweave/agents-model";
import { basename, compare } from "./util";
import type { AssetToWrite } from "./write";

/** Most files one asset of a setup folder may have, as a scan keeps for one asset. */
const MAX_ASSET_FILES = 500;

export interface SetupFolder {
	name: string;
	description: string | null;
	runtimes: RepositoryRuntime[];
	assets: AssetToWrite[];
}

export type SetupFolderResult =
	| { ok: true; setup: SetupFolder }
	| { ok: false; problems: string[] };

/** Reads a setup folder, given its files' text by path relative to the folder. */
export function readSetupFolder(files: ReadonlyMap<string, string>): SetupFolderResult {
	const text = files.get("setup.json");
	if (text === undefined) return { ok: false, problems: ["There is no setup.json"] };
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, problems: [`setup.json is not valid JSON: ${reason}`] };
	}
	const parsed = setupManifest.safeParse(json);
	if (!parsed.success) {
		return {
			ok: false,
			problems: parsed.error.issues.map((issue) =>
				issue.path.length === 0
					? `setup.json: ${issue.message}`
					: `setup.json at ${issue.path.join(".")}: ${issue.message}`,
			),
		};
	}

	const { name, description, runtimes } = parsed.data;
	const problems: string[] = [];
	const assets: AssetToWrite[] = [];
	for (const asset of parsed.data.assets) {
		const own = files.get(asset.path);
		const prefix = `${asset.path}/`;
		const found =
			own === undefined
				? [...files]
						.filter(([path]) => path.startsWith(prefix))
						.map(([path, content]) => ({ path: path.slice(prefix.length), content }))
						.sort((a, b) => compare(a.path, b.path))
				: [{ path: basename(asset.path), content: own }];
		if (found.length === 0) {
			problems.push(`${asset.name}: there is no file or folder at ${asset.path}`);
		} else if (found.length > MAX_ASSET_FILES) {
			problems.push(`${asset.name}: ${asset.path} has more than ${MAX_ASSET_FILES} files`);
		} else {
			const { kind, description: about, metadata } = asset;
			assets.push({ kind, name: asset.name, description: about, files: found, metadata });
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, setup: { name, description, runtimes, assets } };
}
