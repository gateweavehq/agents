/**
 * Environment sets: the variables and secrets an agent run by Gateweave runs with. A set is a
 * library asset of kind `env-set` with one file, `environment.json`, so its variables are
 * versioned, shown and diffed like any asset and an agent pins a version of it. The file names
 * the secrets but never holds their values: those are sealed (see `secrets.ts`) in `env_secrets`,
 * keyed by the set and the name, so they belong to the set and survive a move of the pin.
 */
import {
	ENV_FILE,
	type EnvOrphan,
	type EnvSecret,
	type EnvSetContent,
	type EnvSetEntry,
	envSetContent,
	type envSetEditInput,
	type envSetInput,
} from "@gateweave/agents-model";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { agentDefinitions, agents, assets, assetVersions, blobs, envSecrets } from "./db/schema";
import { assetHash } from "./hash";
import { libraryKey } from "./library";
import { MAX_KEPT_FILE_BYTES, storeFile } from "./scans";
import { type Db, toAsset } from "./state";

/** A change to an environment set that is refused, with a message fit to show the person who asked. */
export class EnvironmentError extends Error {}

/** Where a secret's value is sealed, which ties the sealed value to its row. */
export function secretPlace(assetId: string, name: string): string {
	return `env-sets/${assetId}/${name}`;
}

/**
 * The file's text for a set. Keys are sorted, with `\n` newlines and one trailing newline, so the
 * same content is always the same bytes and an edit that changes nothing makes no new version.
 */
export function serialiseEnvironment(content: EnvSetContent): string {
	const variables = Object.fromEntries(
		Object.entries(content.variables).sort(([a], [b]) => compare(a, b)),
	);
	const secrets = [...content.secrets].sort(compare);
	return `${JSON.stringify({ variables, secrets }, null, 2)}\n`;
}

/** What a stored `environment.json` says. Only this module writes one, so a bad file is empty. */
function parseEnvironment(text: string | null): EnvSetContent {
	try {
		const parsed = envSetContent.safeParse(JSON.parse(text ?? ""));
		if (parsed.success) return parsed.data;
	} catch {
		// Falls through to the empty set.
	}
	return { variables: {}, secrets: [] };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Creates a set: version 1 of a library asset of kind `env-set`. Returns its id, which a caller
 * that seals the set's secrets before the write chooses itself.
 */
export function createEnvSet(
	db: Db,
	input: z.output<typeof envSetInput>,
	now: number,
	id: string = crypto.randomUUID(),
): string {
	const key = libraryKey("env-set", input.name);
	const taken = db
		.select({ id: assets.id })
		.from(assets)
		.where(and(isNull(assets.repositoryId), isNull(assets.removedAt), eq(assets.key, key)))
		.get();
	if (taken)
		throw new EnvironmentError(`The library already has an environment set named ${input.name}`);
	const files = [fileOf(db, input)];
	const hash = assetHash(files);
	db.insert(assets)
		.values({
			id,
			repositoryId: null,
			kind: "env-set",
			key,
			name: input.name,
			description: null,
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
 * Saves new variables and secret names for a set as its next version. Content that serialises
 * to what the set already has adds no version. Returns the set's current version.
 */
export function editEnvSet(db: Db, input: z.output<typeof envSetEditInput>, now: number): number {
	const asset = liveSet(db, input.assetId);
	const files = [fileOf(db, input)];
	const hash = assetHash(files);
	if (hash === asset.hash) return asset.version;
	const version = asset.version + 1;
	db.insert(assetVersions)
		.values({ assetId: asset.id, version, hash, commit: null, files, createdAt: now })
		.run();
	db.update(assets).set({ version, hash, updatedAt: now }).where(eq(assets.id, asset.id)).run();
	return version;
}

function fileOf(db: Db, content: EnvSetContent) {
	const text = serialiseEnvironment(content);
	if (new TextEncoder().encode(text).byteLength > MAX_KEPT_FILE_BYTES) {
		throw new EnvironmentError("That environment set is too large");
	}
	return storeFile(db, { path: ENV_FILE, content: text });
}

/** A set that is in the library, or why it is not. */
function liveSet(db: Db, assetId: string) {
	const asset = db
		.select()
		.from(assets)
		.where(and(eq(assets.id, assetId), isNull(assets.repositoryId), eq(assets.kind, "env-set")))
		.get();
	if (!asset) throw new EnvironmentError("That environment set does not exist");
	if (asset.removedAt !== null) {
		throw new EnvironmentError(`${asset.name} is no longer in the library`);
	}
	return asset;
}

/** The content of one version of a set; empty when the version or its text is not there. */
function contentOf(db: Db, assetId: string, version: number): EnvSetContent {
	const row = db
		.select({ files: assetVersions.files })
		.from(assetVersions)
		.where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.version, version)))
		.get();
	const file = row?.files.find((candidate) => candidate.path === ENV_FILE);
	if (!file) return { variables: {}, secrets: [] };
	const blob = db
		.select({ content: blobs.content })
		.from(blobs)
		.where(eq(blobs.id, file.blob))
		.get();
	return parseEnvironment(blob?.content ?? null);
}

/** Every set in the library with its variables, which secrets have a value, and who uses it. */
export function listEnvSets(db: Db): EnvSetEntry[] {
	const rows = db
		.select()
		.from(assets)
		.where(and(isNull(assets.repositoryId), isNull(assets.removedAt), eq(assets.kind, "env-set")))
		.orderBy(asc(assets.name))
		.all();
	return rows.map((row) => {
		const content = contentOf(db, row.id, row.version);
		const stored = new Map(
			db
				.select()
				.from(envSecrets)
				.where(eq(envSecrets.assetId, row.id))
				.all()
				.map((secret) => [secret.name, secret] as const),
		);
		const declared = [...content.secrets].sort(compare);
		const secrets: EnvSecret[] = declared.map((name) => {
			const value = stored.get(name);
			return value
				? { name, state: "set", setBy: value.setBy, setAt: value.setAt }
				: { name, state: "missing", setBy: null, setAt: null };
		});
		const orphans: EnvOrphan[] = [...stored.values()]
			.filter((secret) => !declared.includes(secret.name))
			.sort((a, b) => compare(a.name, b.name))
			.map(({ name, setBy, setAt }) => ({ name, setBy, setAt }));
		const users = db
			.select({
				id: agents.id,
				name: agents.name,
				version: agentDefinitions.envSetVersion,
			})
			.from(agentDefinitions)
			.innerJoin(agents, eq(agents.id, agentDefinitions.agentId))
			.where(and(eq(agentDefinitions.envSetAssetId, row.id), isNull(agents.removedAt)))
			.orderBy(asc(agents.name))
			.all();
		return {
			asset: toAsset(row),
			variables: Object.fromEntries(
				Object.entries(content.variables).sort(([a], [b]) => compare(a, b)),
			),
			secrets,
			orphans,
			agents: users.map((user) => ({ ...user, version: user.version ?? row.version })),
		};
	});
}

/**
 * Stores a sealed value for a secret of the set's current version. Checked here, in the write,
 * and not only before sealing: the set may have changed while the value was being sealed.
 */
export function storeEnvSecret(
	db: Db,
	secret: { assetId: string; name: string; sealed: string; setBy: string },
	now: number,
): void {
	checkEnvSecretName(db, secret.assetId, secret.name);
	const row = { ...secret, setAt: now };
	db.insert(envSecrets)
		.values(row)
		.onConflictDoUpdate({ target: [envSecrets.assetId, envSecrets.name], set: row })
		.run();
}

/** Removes a stored value, whether or not the name is still a secret. False when none was stored. */
export function removeEnvSecret(db: Db, assetId: string, name: string): boolean {
	return (
		db
			.delete(envSecrets)
			.where(and(eq(envSecrets.assetId, assetId), eq(envSecrets.name, name)))
			.returning({ name: envSecrets.name })
			.get() !== undefined
	);
}

/** Whether `name` is a secret of the set's current version, for refusing early, before sealing. */
export function checkEnvSecretName(db: Db, assetId: string, name: string): void {
	const asset = liveSet(db, assetId);
	if (!contentOf(db, asset.id, asset.version).secrets.includes(name)) {
		throw new EnvironmentError(`${name} is not a secret of ${asset.name}`);
	}
}

/**
 * What the agent's pinned set holds, read in one go: its variables, and the sealed value of each
 * secret it names, if there is one. Null when there is no such live agent run by Gateweave.
 */
export function pinnedEnvironment(
	db: Db,
	agentId: string,
): {
	assetId: string | null;
	variables: Record<string, string>;
	secrets: { name: string; sealed: string | null }[];
} | null {
	const found = db
		.select({ definition: agentDefinitions })
		.from(agentDefinitions)
		.innerJoin(agents, eq(agents.id, agentDefinitions.agentId))
		.where(and(eq(agentDefinitions.agentId, agentId), isNull(agents.removedAt)))
		.get();
	if (!found) return null;
	const { envSetAssetId: assetId, envSetVersion: version } = found.definition;
	if (assetId === null || version === null) return { assetId: null, variables: {}, secrets: [] };
	const content = contentOf(db, assetId, version);
	const stored = new Map(
		db
			.select({ name: envSecrets.name, sealed: envSecrets.sealed })
			.from(envSecrets)
			.where(eq(envSecrets.assetId, assetId))
			.all()
			.map((secret) => [secret.name, secret.sealed] as const),
	);
	return {
		assetId,
		variables: content.variables,
		secrets: [...content.secrets]
			.sort(compare)
			.map((name) => ({ name, sealed: stored.get(name) ?? null })),
	};
}
