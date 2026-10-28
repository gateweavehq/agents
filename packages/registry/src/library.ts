/**
 * Changes to the library: assets kept outside any repository and versioned like scanned ones. A
 * library asset starts as a copy of a repository asset; its versions are compared with
 * repository assets by hash, so the registry can say where each version is used.
 */
import { parseFrontMatter } from "@gateweave/agents-adapters";
import type {
	libraryEditInput,
	libraryTarget,
	setupImportInput,
	writtenAssetInput,
} from "@gateweave/agents-model";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { z } from "zod";
import { assets, assetVersions, blobs, type FileEntry, repositories } from "./db/schema";
import { assetHash } from "./hash";
import { MAX_KEPT_FILE_BYTES, storeFile } from "./scans";
import type { Db } from "./state";

/** A change the library refuses, with a message fit to show the person who asked. */
export class LibraryError extends Error {}

/** The files each coding agent reads its instructions from, which the writers place by name. */
const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

/** The key of a library asset: unique among live library assets of every kind. */
export const libraryKey = (kind: string, name: string) => `${kind}:${name}`;

/** Environment sets hold secrets by name, so they are written only through `environment.ts`. */
const ENVIRONMENT_ONLY = "Environment sets are managed on the Environment page";

/** A server's headers name variables and never hold their values, which only its form checks. */
const MCP_FORM_ONLY =
	"MCP servers are edited with their settings, which keep secrets out of the file";

/**
 * Copies a repository asset's current content into the library, as a new library asset or a new
 * version of one. Returns the library asset's id. A copy whose content the library asset already
 * has as its current version changes nothing.
 */
export function addToLibrary(
	db: Db,
	sourceAssetId: string,
	target: z.output<typeof libraryTarget>,
	now: number,
): string {
	const source = db
		.select({ asset: assets })
		.from(assets)
		.innerJoin(repositories, eq(assets.repositoryId, repositories.id))
		.where(
			and(
				eq(assets.id, sourceAssetId),
				isNull(assets.removedAt),
				isNull(repositories.removedAt),
				isNotNull(assets.repositoryId),
			),
		)
		.get()?.asset;
	if (!source) throw new LibraryError("That asset is not in a repository of this workspace");
	if (source.kind === "env-set") throw new LibraryError(ENVIRONMENT_ONLY);
	const content = db
		.select()
		.from(assetVersions)
		.where(and(eq(assetVersions.assetId, source.id), eq(assetVersions.version, source.version)))
		.get();
	if (!content) throw new Error(`Asset ${source.id} has no version ${source.version}`);
	const copy = { hash: content.hash, commit: content.commit, files: content.files, createdAt: now };

	if ("name" in target) {
		const key = libraryKey(source.kind, target.name);
		const taken = db
			.select({ id: assets.id })
			.from(assets)
			.where(and(isNull(assets.repositoryId), isNull(assets.removedAt), eq(assets.key, key)))
			.get();
		if (taken) {
			throw new LibraryError(`The library already has a ${source.kind} named ${target.name}`);
		}
		const id = crypto.randomUUID();
		db.insert(assets)
			.values({
				id,
				repositoryId: null,
				kind: source.kind,
				key,
				name: target.name,
				description: source.description,
				path: null,
				metadata: source.metadata,
				version: 1,
				hash: content.hash,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(assetVersions)
			.values({ assetId: id, version: 1, ...copy })
			.run();
		return id;
	}

	const library = db
		.select()
		.from(assets)
		.where(
			and(
				eq(assets.id, target.libraryAssetId),
				isNull(assets.repositoryId),
				isNull(assets.removedAt),
			),
		)
		.get();
	if (!library) throw new LibraryError("That library asset does not exist");
	if (library.kind !== source.kind) {
		throw new LibraryError(`A ${source.kind} cannot become a version of a ${library.kind}`);
	}
	if (library.hash === content.hash) return library.id;
	const version = library.version + 1;
	db.insert(assetVersions)
		.values({ assetId: library.id, version, ...copy })
		.run();
	db.update(assets)
		.set({
			version,
			hash: content.hash,
			description: source.description,
			metadata: source.metadata,
			updatedAt: now,
		})
		.where(eq(assets.id, library.id))
		.run();
	return library.id;
}

/** Takes an asset out of the library. Its versions stay, for setups that pinned them. */
export function removeFromLibrary(db: Db, id: string, now: number): boolean {
	return (
		db
			.update(assets)
			.set({ removedAt: now, updatedAt: now })
			.where(and(eq(assets.id, id), isNull(assets.repositoryId), isNull(assets.removedAt)))
			.returning({ id: assets.id })
			.get() !== undefined
	);
}

/**
 * The file a written asset keeps its text in. It is the name a scan gives the same file, so a
 * repository carrying this text has the same asset hash and shows up under "Used in": scanned
 * instructions keep their file's name, so instructions named after an agent's own file (as
 * `CLAUDE.md` or `packages/api/GEMINI.md`) are that file and the rest are `AGENTS.md`, and a
 * skill is `SKILL.md`. A prompt's file is named after the prompt, as a command file is, in a form
 * that is a safe single path segment.
 */
function writtenFileName(kind: "instructions" | "prompt" | "skill", name: string): string {
	if (kind === "instructions") {
		const file = name.split("/").at(-1) ?? "";
		return INSTRUCTION_FILES.has(file) ? file : "AGENTS.md";
	}
	if (kind === "skill") return "SKILL.md";
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|-+$/g, "")
		.slice(0, 100);
	return `${slug || "prompt"}.md`;
}

/**
 * A skill's description as a scan reads it, from the front matter of its SKILL.md. Undefined when
 * the front matter is not valid, which a scan would refuse: the asset keeps what it had.
 */
function skillDescription(text: string): string | null | undefined {
	const front = parseFrontMatter(text);
	if (!front.ok) return undefined;
	const description = front.data.description;
	if (typeof description !== "string" || description.trim() === "") return null;
	return description.trim().slice(0, 2000);
}

/** Refuses text the registry would not keep, since an edit that cannot be shown again is no edit. */
function checkSize(path: string, text: string): void {
	if (new TextEncoder().encode(text).byteLength > MAX_KEPT_FILE_BYTES) {
		throw new LibraryError(`${path} is too large: the library keeps up to 256 KiB per file`);
	}
}

/** Creates a library asset from text typed in the app: version 1, with one file. Returns its id. */
export function createLibraryAsset(
	db: Db,
	input: z.output<typeof writtenAssetInput>,
	now: number,
): string {
	const key = libraryKey(input.kind, input.name);
	const taken = db
		.select({ id: assets.id })
		.from(assets)
		.where(and(isNull(assets.repositoryId), isNull(assets.removedAt), eq(assets.key, key)))
		.get();
	if (taken) {
		throw new LibraryError(`The library already has a ${input.kind} named ${input.name}`);
	}
	const path = writtenFileName(input.kind, input.name);
	checkSize(path, input.text);
	const files = [storeFile(db, { path, content: input.text })];
	const hash = assetHash(files);
	const id = crypto.randomUUID();
	db.insert(assets)
		.values({
			id,
			repositoryId: null,
			kind: input.kind,
			key,
			name: input.name,
			description: input.kind === "skill" ? (skillDescription(input.text) ?? null) : null,
			path: null,
			version: 1,
			hash,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(assetVersions)
		.values({ assetId: id, version: 1, hash, commit: null, files, createdAt: now })
		.run();
	return id;
}

/**
 * Saves new text for files of a library asset as its next version. Only files whose text the
 * registry kept can be edited. Saving text that changes nothing adds no version. Returns the
 * asset's current version.
 */
export function editLibraryAsset(
	db: Db,
	input: z.output<typeof libraryEditInput>,
	now: number,
): number {
	const asset = db
		.select()
		.from(assets)
		.where(and(eq(assets.id, input.libraryAssetId), isNull(assets.removedAt)))
		.get();
	if (!asset) throw new LibraryError("That library asset does not exist");
	if (asset.kind === "env-set") throw new LibraryError(ENVIRONMENT_ONLY);
	if (asset.kind === "mcp-server") throw new LibraryError(MCP_FORM_ONLY);
	if (asset.repositoryId !== null) {
		throw new LibraryError("Only library assets can be edited here; a repository's files are read");
	}
	const current = db
		.select()
		.from(assetVersions)
		.where(and(eq(assetVersions.assetId, asset.id), eq(assetVersions.version, asset.version)))
		.get();
	if (!current) throw new Error(`Asset ${asset.id} has no version ${asset.version}`);

	const edits = new Map(input.files.map((file) => [file.path, file.content]));
	const files: FileEntry[] = [];
	for (const file of current.files) {
		const text = edits.get(file.path);
		if (text === undefined) {
			files.push(file);
			continue;
		}
		const kept = db
			.select({ content: blobs.content })
			.from(blobs)
			.where(eq(blobs.id, file.blob))
			.get();
		if (kept?.content == null) {
			throw new LibraryError(`The text of ${file.path} is not kept, so it cannot be edited`);
		}
		checkSize(file.path, text);
		files.push(storeFile(db, { path: file.path, content: text }));
		edits.delete(file.path);
	}
	for (const path of edits.keys()) throw new LibraryError(`The asset has no file ${path}`);

	const hash = assetHash(files);
	if (hash === asset.hash) return asset.version;
	const version = asset.version + 1;
	const skillText = asset.kind === "skill" ? input.files.find((f) => f.path === "SKILL.md") : null;
	const description = skillText ? skillDescription(skillText.content) : undefined;
	db.insert(assetVersions)
		.values({ assetId: asset.id, version, hash, commit: null, files, createdAt: now })
		.run();
	db.update(assets)
		.set({
			version,
			hash,
			updatedAt: now,
			...(description === undefined ? {} : { description }),
		})
		.where(eq(assets.id, asset.id))
		.run();
	return version;
}

/**
 * Puts an asset's files in the library for a setup to pin, and returns the pin. A live library
 * asset of the same kind and name that has ever had these exact files gives that version, so
 * adding a setup twice, or two setups that share an asset, make no copies. Otherwise the files
 * are the asset's next version, or its first when the library has none by that name.
 */
export function importLibraryAsset(
	db: Db,
	input: z.output<typeof setupImportInput>["assets"][number],
	now: number,
): { assetId: string; version: number } {
	if (input.kind === "env-set") throw new LibraryError(ENVIRONMENT_ONLY);
	const files = input.files.map((file) => {
		checkSize(file.path, file.content);
		return storeFile(db, file);
	});
	const hash = assetHash(files);
	const key = libraryKey(input.kind, input.name);
	const existing = db
		.select()
		.from(assets)
		.where(and(isNull(assets.repositoryId), isNull(assets.removedAt), eq(assets.key, key)))
		.get();

	if (!existing) {
		const id = crypto.randomUUID();
		db.insert(assets)
			.values({
				id,
				repositoryId: null,
				kind: input.kind,
				key,
				name: input.name,
				description: input.description,
				path: null,
				metadata: input.metadata,
				version: 1,
				hash,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(assetVersions)
			.values({ assetId: id, version: 1, hash, commit: null, files, createdAt: now })
			.run();
		return { assetId: id, version: 1 };
	}

	const same = db
		.select({ version: assetVersions.version })
		.from(assetVersions)
		.where(and(eq(assetVersions.assetId, existing.id), eq(assetVersions.hash, hash)))
		.get();
	if (same) return { assetId: existing.id, version: same.version };

	const version = existing.version + 1;
	db.insert(assetVersions)
		.values({ assetId: existing.id, version, hash, commit: null, files, createdAt: now })
		.run();
	db.update(assets)
		.set({
			version,
			hash,
			description: input.description,
			metadata: input.metadata,
			updatedAt: now,
		})
		.where(eq(assets.id, existing.id))
		.run();
	return { assetId: existing.id, version };
}
