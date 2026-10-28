/**
 * Where a setup comes from: a folder on disk, or a ready-made setup by name. The ready-made ones
 * are bundled into the CLI, so it works offline and a version always applies the same setup.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSetupFolder, type SetupFolderResult } from "@gateweave/agents-adapters";

/** Most files a setup folder may hold. Ready-made setups have a handful. */
const MAX_FOLDER_FILES = 2000;
/** Folders that never belong to a setup. */
const SKIPPED = new Set([".git", "node_modules"]);

const BUNDLED = import.meta.glob<string>("../../../setups/*/**", {
	query: "?raw",
	import: "default",
	eager: true,
});

/** The ready-made setups' files, by setup folder name and then by path inside it. */
export const READY_MADE: ReadonlyMap<string, ReadonlyMap<string, string>> = group(BUNDLED);

function group(files: Record<string, string>): Map<string, Map<string, string>> {
	const setups = new Map<string, Map<string, string>>();
	for (const [key, content] of Object.entries(files)) {
		const [name, ...rest] = key.slice(key.indexOf("setups/") + "setups/".length).split("/");
		if (name === undefined || rest.length === 0) continue;
		const folder = setups.get(name) ?? new Map<string, string>();
		folder.set(rest.join("/"), lf(content));
		setups.set(name, folder);
	}
	return new Map([...setups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A checkout may have CRLF; a setup writes LF, as the working tree is compared in LF. */
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
