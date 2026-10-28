/**
 * Changes to setups: library assets pinned to versions, for the coding agents a setup configures.
 * What a setup writes comes from the pinned versions alone, so it changes only when someone moves
 * a pin.
 */
import type { Setup, setupInput, setupPins } from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { assets, assetVersions, setupAssets, setups } from "./db/schema";
import { type Db, toSetup } from "./state";

/** A change to a setup that is refused, with a message fit to show the person who asked. */
export class SetupError extends Error {}

export function createSetup(db: Db, input: z.output<typeof setupInput>, now: number): Setup {
	const row = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
	db.insert(setups).values(row).run();
	return toSetup(row);
}

export function updateSetup(
	db: Db,
	id: string,
	input: z.output<typeof setupInput>,
	now: number,
): Setup | null {
	const row = db
		.update(setups)
		.set({ ...input, updatedAt: now })
		.where(eq(setups.id, id))
		.returning()
		.get();
	return row ? toSetup(row) : null;
}

export function deleteSetup(db: Db, id: string): boolean {
	db.delete(setupAssets).where(eq(setupAssets.setupId, id)).run();
	return (
		db.delete(setups).where(eq(setups.id, id)).returning({ id: setups.id }).get() !== undefined
	);
}

/**
 * Gives a setup exactly these pins. Each must name a version of a library asset. An asset that
 * has left the library can keep the pin it had, so removing it from the library does not change
 * what the setup writes, but it cannot be pinned anew.
 */
export function setSetupAssets(
	db: Db,
	setupId: string,
	pins: z.output<typeof setupPins>,
	now: number,
): Setup | null {
	const setup = db.select().from(setups).where(eq(setups.id, setupId)).get();
	if (!setup) return null;
	const pinned = new Set(
		db
			.select({ assetId: setupAssets.assetId })
			.from(setupAssets)
			.where(eq(setupAssets.setupId, setupId))
			.all()
			.map((pin) => pin.assetId),
	);
	for (const pin of pins) {
		const asset = db
			.select({ name: assets.name, removedAt: assets.removedAt })
			.from(assets)
			.where(and(eq(assets.id, pin.assetId), isNull(assets.repositoryId)))
			.get();
		if (!asset) throw new SetupError("That library asset does not exist");
		if (asset.removedAt !== null && !pinned.has(pin.assetId)) {
			throw new SetupError(`${asset.name} is no longer in the library`);
		}
		const version = db
			.select({ version: assetVersions.version })
			.from(assetVersions)
			.where(and(eq(assetVersions.assetId, pin.assetId), eq(assetVersions.version, pin.version)))
			.get();
		if (!version) throw new SetupError(`${asset.name} has no version ${pin.version}`);
	}
	db.delete(setupAssets).where(eq(setupAssets.setupId, setupId)).run();
	for (const pin of pins) {
		db.insert(setupAssets)
			.values({ setupId, ...pin })
			.run();
	}
	const row = db
		.update(setups)
		.set({ updatedAt: now })
		.where(eq(setups.id, setupId))
		.returning()
		.get();
	return row ? toSetup(row) : null;
}
