/**
 * Changes to the library: assets kept outside any repository and versioned like scanned ones. A
 * library asset starts as a copy of a repository asset; its versions are compared with
 * repository assets by hash, so the registry can say where each version is used.
 */
import type { libraryTarget } from "@gateweave/agents-model";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { z } from "zod";
import { assets, assetVersions, repositories } from "./db/schema";
import type { Db } from "./state";

/** A change the library refuses, with a message fit to show the person who asked. */
export class LibraryError extends Error {}

/** The key of a library asset: unique among live library assets of every kind. */
const libraryKey = (kind: string, name: string) => `${kind}:${name}`;

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
