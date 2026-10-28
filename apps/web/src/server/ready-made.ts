/**
 * The ready-made setups: the folders under `setups/` at the repository root, bundled into the
 * Worker as text so they need no storage of their own. Server only (see AGENTS.md); import it
 * dynamically from a server function.
 */
import { readSetupFolder, type SetupFolder } from "@gateweave/agents-adapters";
import type { SetupImportInput } from "@gateweave/agents-model";

// Dotfiles are left out by the glob, and the tests keep folders free of them.
const bundled = import.meta.glob("../../../../setups/*/**", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

export interface ReadyMadeSetup {
	slug: string;
	setup: SetupFolder;
}

export type ReadyMadeResult =
	| { slug: string; ok: true; setup: SetupFolder }
	| { slug: string; ok: false; problems: string[] };

/** Every bundled folder, read: a broken one is reported rather than hidden. Sorted by slug. */
export function readyMadeResults(): ReadyMadeResult[] {
	const folders = new Map<string, Map<string, string>>();
	for (const [path, text] of Object.entries(bundled)) {
		const match = /\/setups\/([^/]+)\/(.+)$/.exec(path);
		if (!match?.[1] || !match[2]) continue;
		const files = folders.get(match[1]) ?? new Map<string, string>();
		files.set(match[2], text);
		folders.set(match[1], files);
	}
	return [...folders]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([slug, files]) => ({ slug, ...readSetupFolder(files) }));
}

/** The folders that read; one that does not is logged and left out, so the others still show. */
export function readyMadeSetups(): ReadyMadeSetup[] {
	const setups: ReadyMadeSetup[] = [];
	for (const result of readyMadeResults()) {
		if (result.ok) setups.push({ slug: result.slug, setup: result.setup });
		else console.error(`ready-made setup ${result.slug} is broken`, result.problems);
	}
	return setups;
}

/** What the registry takes to add the setup to a workspace. */
export function importInputOf({ setup }: ReadyMadeSetup): SetupImportInput {
	return {
		name: setup.name,
		description: setup.description,
		runtimes: setup.runtimes,
		assets: setup.assets.map((asset) => ({
			kind: asset.kind,
			name: asset.name,
			description: asset.description,
			metadata: asset.metadata,
			// The folder reader gives text for every file.
			files: asset.files.map((file) => ({ path: file.path, content: file.content ?? "" })),
		})),
	};
}
