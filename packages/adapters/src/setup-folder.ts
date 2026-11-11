/**
 * A setup kept as plain files: `setup.json` (see `setupManifest` in the model) and the files of
 * its assets. Ready-made setups ship this way, so contributors propose one as a folder, and the
 * CLI reads one from disk. Pure, so both read it the same way.
 */
import { mcpServerUrl, type SetupRuntime, setupManifest } from "@gateweave/agents-model";
import { basename, compare, isPlainObject } from "./util";
import type { AssetToWrite } from "./write";
import { readMcpConnection } from "./write-mcp";

/** Most files one asset of a setup folder may have, as a scan keeps for one asset. */
const MAX_ASSET_FILES = 500;

export interface SetupFolder {
	name: string;
	description: string | null;
	runtimes: SetupRuntime[];
	assets: AssetToWrite[];
	/** The MCP servers whose address whoever adds the setup gives (`askUrl`), in manifest order. */
	addresses: AskedAddress[];
}

/** An MCP server's address that a setup asks for, since it differs from one install to the next. */
export interface AskedAddress {
	/** The server's asset name. */
	server: string;
	/** What to ask, from the manifest. */
	label: string;
	/** The address the folder's file holds, which shows what one looks like. */
	example: string;
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
	const addresses: AskedAddress[] = [];
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
			if (asset.askUrl !== undefined) {
				const example = askedUrl(found);
				if (typeof example === "string") {
					addresses.push({ server: asset.name, label: asset.askUrl, example });
				} else {
					problems.push(`${asset.name}: ${example.problem}`);
				}
			}
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, setup: { name, description, runtimes, assets, addresses } };
}

/**
 * The address in a server whose address is asked for, or why it cannot be asked for. Only a
 * plain JSON file with a `url` is rewritten, so nothing else in it changes when the answer goes in.
 */
function askedUrl(files: AssetToWrite["files"]): string | { problem: string } {
	const connection = readMcpConnection(files);
	if (!connection.ok) return { problem: connection.message };
	if (connection.connection.transport === "stdio") {
		return { problem: "askUrl is for a server reached over the network, not a local command" };
	}
	const [file] = files;
	const value = file?.content ? parsePlainJson(file.content) : undefined;
	if (
		!file?.path.endsWith(".json") ||
		!isPlainObject(value) ||
		typeof value.url !== "string" ||
		// Gemini's `httpUrl` would be the address used, and the one given would go unread.
		value.url !== connection.connection.url
	) {
		return { problem: "askUrl needs the server in a JSON file with a url" };
	}
	const example = mcpServerUrl.safeParse(value.url);
	if (!example.success) {
		return { problem: `its example address: ${example.error.issues[0]?.message ?? "not valid"}` };
	}
	return example.data;
}

function parsePlainJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The setup with the addresses it asks for given, by server name: each server's file holds the
 * given address instead of its example. Every address asked for must be given, and nothing else.
 */
export function withAddresses(
	setup: SetupFolder,
	given: Readonly<Record<string, string>>,
): SetupFolderResult {
	const problems: string[] = [];
	const asked = new Map(setup.addresses.map((address) => [address.server, address]));
	for (const name of Object.keys(given)) {
		if (!asked.has(name)) problems.push(`${setup.name} asks for no address for ${name}`);
	}
	const answers = new Map<string, string>();
	for (const { server, label } of setup.addresses) {
		const value = Object.hasOwn(given, server) ? given[server] : undefined;
		if (value === undefined || value.trim() === "") {
			problems.push(`${server}: give its address (${label})`);
			continue;
		}
		const url = mcpServerUrl.safeParse(value);
		if (url.success) answers.set(server, url.data);
		else problems.push(`${server}: ${url.error.issues[0]?.message ?? "not a valid address"}`);
	}
	if (problems.length > 0) return { ok: false, problems };

	const assets = setup.assets.map((asset) => {
		const url = asset.kind === "mcp-server" ? answers.get(asset.name) : undefined;
		if (url === undefined) return asset;
		return {
			...asset,
			files: asset.files.map((file) => {
				// The folder was read with this file as plain JSON holding a url.
				const value = parsePlainJson(file.content ?? "") as Record<string, unknown>;
				return { path: file.path, content: `${JSON.stringify({ ...value, url }, null, 2)}\n` };
			}),
		};
	});
	return { ok: true, setup: { ...setup, assets, addresses: [] } };
}

/**
 * The ready-made setups as a bundler gives them (Vite's `import.meta.glob` of `setups/*\/**`), by
 * folder name and then by path inside the folder, sorted by folder. The Worker and the CLI bundle
 * the same folders, so they group them the same way. A file directly under `setups/` belongs to
 * no setup.
 */
export function groupSetupFolders(
	bundled: Readonly<Record<string, string>>,
): Map<string, Map<string, string>> {
	const folders = new Map<string, Map<string, string>>();
	for (const [key, text] of Object.entries(bundled)) {
		const match = /(?:^|\/)setups\/([^/]+)\/(.+)$/.exec(key);
		if (!match?.[1] || !match[2]) continue;
		const files = folders.get(match[1]) ?? new Map<string, string>();
		files.set(match[2], text);
		folders.set(match[1], files);
	}
	return new Map([...folders].sort(([a], [b]) => compare(a, b)));
}
