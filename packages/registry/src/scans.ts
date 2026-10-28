import type {
	DetectedAsset,
	RepositoryInput,
	ScannedFile,
	ScanResult,
} from "@gateweave/agents-model";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
	type AssetRow,
	agentAssets,
	agents,
	assets,
	assetVersions,
	blobs,
	type FileEntry,
	repositories,
} from "./db/schema";
import { assetHash, gitBlobId } from "./hash";
import { requestScans } from "./queue";
import type { Db } from "./state";

/** Files larger than this keep their blob id and size, but not their text. */
export const MAX_KEPT_FILE_BYTES = 256 * 1024;

/** What happened to a scan: applied, older than the last one applied, or for no live repository. */
export type ScanOutcome = "applied" | "stale" | "not_found";

const encoder = new TextEncoder();

/**
 * Adds repositories an installation reaches and updates the ones already known, matched by the
 * provider's id, so a renamed or transferred repository keeps its id. Returns the ids in input
 * order.
 */
export function syncRepositories(db: Db, inputs: RepositoryInput[], now: number): string[] {
	return syncEach(db, inputs, now).map(({ id }) => id);
}

/**
 * `syncRepositories`, also saying which repositories need a scan: new ones, ones back after
 * being removed, ones whose default branch changed and ones never scanned.
 */
function syncEach(
	db: Db,
	inputs: RepositoryInput[],
	now: number,
): { id: string; needsScan: boolean }[] {
	return inputs.map((input) => {
		const existing = db
			.select()
			.from(repositories)
			.where(
				and(
					eq(repositories.provider, input.provider),
					eq(repositories.externalId, input.externalId),
				),
			)
			.get();
		if (!existing) {
			const id = crypto.randomUUID();
			db.insert(repositories)
				.values({ id, ...input, createdAt: now, updatedAt: now })
				.run();
			return { id, needsScan: true };
		}
		const needsScan =
			existing.removedAt !== null ||
			existing.defaultBranch !== input.defaultBranch ||
			existing.scannedCommit === null;
		if (existing.removedAt !== null || !sameFields(existing, input)) {
			const { installationId, owner, name, defaultBranch, private: isPrivate } = input;
			db.update(repositories)
				.set({
					installationId,
					owner,
					name,
					defaultBranch,
					private: isPrivate,
					removedAt: null,
					updatedAt: now,
				})
				.where(eq(repositories.id, existing.id))
				.run();
		}
		return { id: existing.id, needsScan };
	});
}

/**
 * Makes the installation's repositories match the list GitHub gave: adds and updates those in
 * it, marks the installation's others as removed, and queues a scan of those that need one.
 * Returns the ids in input order.
 */
export function reconcileInstallation(
	db: Db,
	installationId: string,
	inputs: RepositoryInput[],
	now: number,
): string[] {
	const synced = syncEach(db, inputs, now);
	requestScans(
		db,
		synced.filter(({ needsScan }) => needsScan).map(({ id }) => id),
		now,
	);
	const ids = synced.map(({ id }) => id);
	const kept = new Set(ids);
	const known = db
		.select({ id: repositories.id })
		.from(repositories)
		.where(and(eq(repositories.installationId, installationId), isNull(repositories.removedAt)))
		.all();
	for (const { id } of known) {
		if (kept.has(id)) continue;
		db.update(repositories)
			.set({ removedAt: now, updatedAt: now })
			.where(eq(repositories.id, id))
			.run();
	}
	return ids;
}

/** Marks every repository of an installation as removed, when it is uninstalled or unlinked. */
export function removeInstallation(db: Db, installationId: string, now: number): void {
	db.update(repositories)
		.set({ removedAt: now, updatedAt: now })
		.where(and(eq(repositories.installationId, installationId), isNull(repositories.removedAt)))
		.run();
}

/** Records why a scan failed. What earlier scans found stays. */
export function recordScanError(
	db: Db,
	repositoryId: string,
	message: string,
	now: number,
): boolean {
	const updated = db
		.update(repositories)
		.set({ scanError: message, updatedAt: now })
		.where(and(eq(repositories.id, repositoryId), isNull(repositories.removedAt)))
		.returning({ id: repositories.id })
		.get();
	return updated !== undefined;
}

/**
 * Makes the repository's agents and assets match one scan. Assets whose content changed get a
 * new version; agents and assets the scan did not find are marked removed.
 */
export function applyScan(
	db: Db,
	repositoryId: string,
	scan: ScanResult,
	now: number,
): ScanOutcome {
	const repository = db
		.select({ scannedAt: repositories.scannedAt })
		.from(repositories)
		.where(and(eq(repositories.id, repositoryId), isNull(repositories.removedAt)))
		.get();
	if (!repository) return "not_found";
	if (repository.scannedAt !== null && scan.scannedAt < repository.scannedAt) return "stale";

	const assetIds = applyAssets(db, repositoryId, scan, now);

	const knownAgents = new Map(
		db
			.select()
			.from(agents)
			.where(eq(agents.repositoryId, repositoryId))
			.all()
			.map((row) => [`${row.runtime}\0${row.key}`, row]),
	);
	for (const found of scan.agents) {
		const { assets: assetKeys, ...fields } = found;
		const linked = [...new Set(assetKeys.flatMap((key) => assetIds.get(key) ?? []))].sort();
		const identity = `${found.runtime}\0${found.key}`;
		const known = knownAgents.get(identity);
		knownAgents.delete(identity);
		let agentId: string;
		if (known) {
			agentId = known.id;
			const links = db
				.select({ assetId: agentAssets.assetId })
				.from(agentAssets)
				.where(eq(agentAssets.agentId, agentId))
				.all()
				.map((link) => link.assetId)
				.sort();
			if (
				known.removedAt === null &&
				sameFields(known, fields) &&
				links.join("\n") === linked.join("\n")
			) {
				continue;
			}
			db.update(agents)
				.set({ ...fields, removedAt: null, updatedAt: now })
				.where(eq(agents.id, agentId))
				.run();
			db.delete(agentAssets).where(eq(agentAssets.agentId, agentId)).run();
		} else {
			agentId = crypto.randomUUID();
			db.insert(agents)
				.values({ id: agentId, repositoryId, ...fields, createdAt: now, updatedAt: now })
				.run();
		}
		// One row at a time: Durable Object SQLite binds at most 100 parameters per query.
		for (const assetId of linked) db.insert(agentAssets).values({ agentId, assetId }).run();
	}
	for (const gone of knownAgents.values()) {
		if (gone.removedAt !== null) continue;
		db.update(agents).set({ removedAt: now, updatedAt: now }).where(eq(agents.id, gone.id)).run();
	}

	db.update(repositories)
		.set({
			scannedCommit: scan.commit,
			scannedAt: scan.scannedAt,
			scanError: null,
			problems: scan.problems,
			updatedAt: now,
		})
		.where(eq(repositories.id, repositoryId))
		.run();
	return "applied";
}

/** Upserts the scan's assets. Returns their ids by key. */
function applyAssets(
	db: Db,
	repositoryId: string,
	scan: ScanResult,
	now: number,
): Map<string, string> {
	const known = new Map<string, AssetRow>(
		db
			.select()
			.from(assets)
			.where(eq(assets.repositoryId, repositoryId))
			.all()
			.map((row) => [row.key, row]),
	);
	const ids = new Map<string, string>();
	for (const found of scan.assets) {
		const files = found.files.map((file) => storeFile(db, file));
		const hash = assetHash(files);
		const fields = assetFields(found);
		const current = known.get(found.key);
		known.delete(found.key);
		if (!current) {
			const id = crypto.randomUUID();
			db.insert(assets)
				.values({
					id,
					repositoryId,
					key: found.key,
					...fields,
					version: 1,
					hash,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			db.insert(assetVersions)
				.values({ assetId: id, version: 1, hash, commit: scan.commit, files, createdAt: now })
				.run();
			ids.set(found.key, id);
			continue;
		}
		ids.set(found.key, current.id);
		const changed = current.hash !== hash;
		if (!changed && current.removedAt === null && sameFields(current, fields)) continue;
		const version = changed ? current.version + 1 : current.version;
		if (changed) {
			db.insert(assetVersions)
				.values({ assetId: current.id, version, hash, commit: scan.commit, files, createdAt: now })
				.run();
		}
		db.update(assets)
			.set({ ...fields, version, hash, removedAt: null, updatedAt: now })
			.where(eq(assets.id, current.id))
			.run();
	}
	for (const gone of known.values()) {
		if (gone.removedAt !== null) continue;
		db.update(assets).set({ removedAt: now, updatedAt: now }).where(eq(assets.id, gone.id)).run();
	}
	return ids;
}

function assetFields({ kind, name, description, path, metadata }: DetectedAsset) {
	return { kind, name, description, path, metadata };
}

/** Stores a file's content once per blob and returns its entry in a version. */
export function storeFile(db: Db, file: ScannedFile): FileEntry {
	if (file.content === undefined) {
		// The schema requires both when the content is left out.
		const blob = file.blob ?? "";
		const size = file.size ?? 0;
		db.insert(blobs).values({ id: blob, size, content: null }).onConflictDoNothing().run();
		return { path: file.path, blob, size };
	}
	const bytes = encoder.encode(file.content);
	const blob = gitBlobId(bytes);
	if (file.blob !== undefined && file.blob !== blob) {
		throw new Error(`The content of ${file.path} does not match its blob id`);
	}
	const content = bytes.byteLength <= MAX_KEPT_FILE_BYTES ? file.content : null;
	db.insert(blobs)
		.values({ id: blob, size: bytes.byteLength, content })
		.onConflictDoUpdate({
			target: blobs.id,
			// A blob first seen without its text gets it when a scan brings it.
			set: { content: sql`coalesce(${blobs.content}, excluded.content)` },
		})
		.run();
	return { path: file.path, blob, size: bytes.byteLength };
}

/** True when every field in `next` equals the stored one. JSON fields compare by their text. */
function sameFields(stored: object, next: object): boolean {
	const row = stored as Record<string, unknown>;
	return Object.entries(next).every(([key, value]) =>
		typeof value === "object" && value !== null
			? JSON.stringify(row[key]) === JSON.stringify(value)
			: row[key] === value,
	);
}
