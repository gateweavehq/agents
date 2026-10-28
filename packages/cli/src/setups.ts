/**
 * Where a setup comes from: a folder on disk, or a ready-made setup by name. The ready-made ones
 * are bundled into the CLI, so it works offline and a version always applies the same setup.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	groupSetupFolders,
	readSetupFolder,
	type SetupFolderResult,
} from "@gateweave/agents-adapters";

/** Most files a setup folder may hold. Ready-made setups have a handful. */
const MAX_FOLDER_FILES = 2000;
/** Folders that never belong to a setup. */
const SKIPPED = new Set([".git", "node_modules"]);

const BUNDLED = import.meta.glob<string>("../../../setups/*/**", {
	query: "?raw",
	import: "default",
	eager: true,
});

/**
 * The ready-made setups' files, by setup folder name and then by path inside it. `.gitattributes`
 * checks them out with LF everywhere, so they need no line ending fix.
 */
export const READY_MADE: ReadonlyMap<string, ReadonlyMap<string, string>> = groupSetupFolders(
	BUNDLED,
);

/** A folder on disk may have CRLF; a setup writes LF, as the working tree is compared in LF. */
function lf(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

/** `from` names where the setup was looked for, for messages. */
export type LoadedSetup = SetupFolderResult & { from: string };

/**
 * A path (anything with a slash, or starting with a dot) is a folder; a bare word is a ready-made
 * setup, or a folder of that name when there is no such ready-made setup.
 */
export async function loadSetup(target: string, cwd: string): Promise<LoadedSetup> {
	const pathLike = /[\\/]/.test(target) || target.startsWith(".");
	const bundled = pathLike ? undefined : READY_MADE.get(target);
	if (bundled) return { ...readSetupFolder(bundled), from: `the ready-made setup ${target}` };

	const folder = join(cwd, target);
	const stats = await lstat(folder).catch(() => null);
	if (stats?.isDirectory()) {
		const files = await readFolder(folder);
		if (typeof files === "string")
			return { ok: false, problems: [files], from: `the setup in ${folder}` };
		return { ...readSetupFolder(files), from: `the setup in ${folder}` };
	}
	const known = [...READY_MADE.keys()].join(", ") || "none";
	return {
		ok: false,
		problems: [`There is no folder or ready-made setup called ${target} (ready-made: ${known})`],
		from: `the setup ${target}`,
	};
}

/** Every file below `root` by its path relative to it, or what is wrong with the folder. */
async function readFolder(root: string): Promise<Map<string, string> | string> {
	const files = new Map<string, string>();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const pending = [""];
	for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
		for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
			const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!SKIPPED.has(entry.name)) pending.push(path);
			} else if (entry.isFile()) {
				if (files.size === MAX_FOLDER_FILES) {
					return `${root} holds more than ${MAX_FOLDER_FILES} files; is it a setup folder?`;
				}
				try {
					files.set(path, lf(decoder.decode(await readFile(join(root, path)))));
				} catch {
					return `${path} is not UTF-8 text`;
				}
			}
		}
	}
	return files;
}
