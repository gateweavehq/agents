/**
 * The workspace's model provider keys, stored sealed (see `secrets.ts`), shown by their last four
 * characters, and checked by listing the provider's models, which proves a key works without
 * spending tokens. Listing goes straight to the provider; the runtime's model calls go through
 * AI Gateway. Workers AI has no key here: the deployment pays for it.
 *
 * Provider APIs, checked 2026-10-28:
 * - https://platform.claude.com/docs/en/api/models/list (`GET /v1/models`, newest first, paged
 *   with `after_id`; the key in `x-api-key`, with the long-stable `anthropic-version`)
 * - https://developers.openai.com/api/reference/resources/models/methods/list (`GET /v1/models`,
 *   one page)
 * - https://ai.google.dev/api/models (`GET /v1beta/models`, paged with `pageToken`; only models
 *   with `generateContent` can chat)
 */
import {
	KEYED_PROVIDERS,
	type KeyedProvider,
	MODEL_PROVIDER_NAMES,
	type ProviderKey,
	type ProviderModel,
} from "@gateweave/agents-model";
import { eq } from "drizzle-orm";
import { type ProviderKeyRow, providerKeys } from "./db/schema";
import type { Db } from "./state";

/** Where a provider's key is sealed, which ties the sealed value to its row. */
export function keyPlace(provider: KeyedProvider): string {
	return `provider-keys/${provider}`;
}

export function listProviderKeys(db: Db): ProviderKey[] {
	const rows = db.select().from(providerKeys).all();
	return KEYED_PROVIDERS.flatMap((provider) => {
		const row = rows.find((candidate) => candidate.provider === provider);
		return row ? [toProviderKey(row)] : [];
	});
}

/** Saves a key, replacing the provider's earlier one and forgetting its check. */
export function saveProviderKey(
	db: Db,
	key: { provider: KeyedProvider; sealed: string; hint: string; addedBy: string },
	now: number,
): ProviderKey {
	const row = {
		...key,
		addedAt: now,
		checkedAt: null,
		checkOk: null,
		checkMessage: null,
		checkModels: null,
	};
	db.insert(providerKeys)
		.values(row)
		.onConflictDoUpdate({ target: providerKeys.provider, set: row })
		.run();
	return toProviderKey(row);
}

export function removeProviderKey(db: Db, provider: KeyedProvider): boolean {
	const removed = db
		.delete(providerKeys)
		.where(eq(providerKeys.provider, provider))
		.returning({ provider: providerKeys.provider })
		.get();
	return removed !== undefined;
}

export function sealedKeyOf(db: Db, provider: KeyedProvider): string | null {
	const row = db
		.select({ sealed: providerKeys.sealed })
		.from(providerKeys)
		.where(eq(providerKeys.provider, provider))
		.get();
	return row?.sealed ?? null;
}

/**
 * Records how checking a key went, unless the key was replaced or removed while the check ran.
 * Returns the key as it is now.
 */
export function recordProviderCheck(
	db: Db,
	provider: KeyedProvider,
	sealed: string,
	result: ModelList,
	now: number,
): ProviderKey | null {
	const row = db.select().from(providerKeys).where(eq(providerKeys.provider, provider)).get();
	if (!row) return null;
	if (row.sealed !== sealed) return toProviderKey(row);
	const check = {
		checkedAt: now,
		checkOk: result.ok,
		checkMessage: result.ok ? null : result.message,
		checkModels: result.ok ? result.models.length : null,
	};
	db.update(providerKeys).set(check).where(eq(providerKeys.provider, provider)).run();
	return toProviderKey({ ...row, ...check });
}

function toProviderKey(row: ProviderKeyRow): ProviderKey {
	const { provider, hint, addedBy, addedAt, checkedAt, checkOk, checkMessage, checkModels } = row;
	return {
		provider,
		hint,
		addedBy,
		addedAt,
		check:
			checkedAt === null
				? null
				: { ok: checkOk === true, message: checkMessage, models: checkModels, checkedAt },
	};
}

export type ModelList = { ok: true; models: ProviderModel[] } | { ok: false; message: string };

/** Pages to read at most; each holds up to 1,000 models, far more than any provider offers. */
const MAX_PAGES = 5;
const TIMEOUT_MS = 10_000;

/**
 * The models a key can use, or why the provider would not say. Messages are the app's own: a
 * provider's error can quote part of the key.
 */
export async function listProviderModels(
	provider: KeyedProvider,
	key: string,
	fetcher: typeof fetch = fetch,
): Promise<ModelList> {
	const name = MODEL_PROVIDER_NAMES[provider];
	const get = async (url: string, headers: Record<string, string>): Promise<unknown> => {
		let response: Response;
		try {
			response = await fetcher(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch {
			throw new ListError(`Could not reach ${name}`);
		}
		if (response.status === 401 || response.status === 403) {
			throw new ListError(`${name} refused the key`);
		}
		if (response.status === 429) {
			throw new ListError(`${name} is limiting requests for this key; try again later`);
		}
		if (!response.ok) throw new ListError(`${name} answered with an error (${response.status})`);
		try {
			return await response.json();
		} catch {
			throw new ListError(`${name} answered with something other than JSON`);
		}
	};
	try {
		const models =
			provider === "anthropic"
				? await anthropicModels(key, get)
				: provider === "openai"
					? await openAiModels(key, get)
					: await googleModels(key, get);
		return { ok: true, models };
	} catch (error) {
		if (error instanceof ListError) return { ok: false, message: error.message };
		throw error;
	}
}

class ListError extends Error {}

type Get = (url: string, headers: Record<string, string>) => Promise<unknown>;

async function anthropicModels(key: string, get: Get): Promise<ProviderModel[]> {
	const models: ProviderModel[] = [];
	let after: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL("https://api.anthropic.com/v1/models");
		url.searchParams.set("limit", "1000");
		if (after) url.searchParams.set("after_id", after);
		const body = record(
			await get(url.href, { "x-api-key": key, "anthropic-version": "2023-06-01" }),
		);
		for (const item of list(body.data)) {
			const model = record(item);
			if (typeof model.id !== "string") continue;
			const name = typeof model.display_name === "string" ? model.display_name : model.id;
			models.push({ id: model.id, name });
		}
		if (body.has_more !== true || typeof body.last_id !== "string") break;
		after = body.last_id;
	}
	return models;
}

async function openAiModels(key: string, get: Get): Promise<ProviderModel[]> {
	const body = record(
		await get("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }),
	);
	return list(body.data)
		.map(record)
		.filter((model) => typeof model.id === "string")
		.sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))
		.map((model) => ({ id: String(model.id), name: String(model.id) }));
}

async function googleModels(key: string, get: Get): Promise<ProviderModel[]> {
	const models: ProviderModel[] = [];
	let token: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
		url.searchParams.set("pageSize", "1000");
		if (token) url.searchParams.set("pageToken", token);
		// In a header rather than the documented `key` parameter, so it stays out of URLs and logs.
		const body = record(await get(url.href, { "x-goog-api-key": key }));
		for (const item of list(body.models)) {
			const model = record(item);
			if (typeof model.name !== "string") continue;
			if (!list(model.supportedGenerationMethods).includes("generateContent")) continue;
			const id = model.name.replace(/^models\//, "");
			models.push({ id, name: typeof model.displayName === "string" ? model.displayName : id });
		}
		if (typeof body.nextPageToken !== "string" || body.nextPageToken === "") break;
		token = body.nextPageToken;
	}
	return models;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
