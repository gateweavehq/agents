/**
 * The models Workers AI offers this server, for the agent dialog's model picker and Settings. The
 * call is the deployment's own, with its token, not a workspace's: Workers AI has no workspace key.
 * The token goes in a header only, and failures are told in the app's words, never Cloudflare's.
 *
 * Cloudflare's catalog, checked 2026-10-29:
 * - https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/
 *   (`GET /accounts/{account_id}/ai/models/search`; each result has a `name`, the model id, and
 *   `properties`, a list of `{ property_id, value }`)
 */
import {
	MODEL_PROVIDER_NAMES,
	type ProviderModel,
	WORKERS_AI_NOT_OFFERED,
	type WorkersAiSettings,
	workersAiAccount,
} from "@gateweave/agents-model";

export type WorkersAiModels =
	| { ok: true; models: ProviderModel[] }
	| { ok: false; message: string };

const NAME = MODEL_PROVIDER_NAMES["workers-ai"];
const TIMEOUT_MS = 10_000;
/** Pages to read at most; the catalog holds a few dozen text models. */
const MAX_PAGES = 5;

/**
 * The text generation models that can call tools, which agents need, or why Cloudflare would not
 * say. Models are in the catalog's order.
 */
export async function listWorkersAiModels(
	settings: WorkersAiSettings,
	fetcher: typeof fetch = fetch,
): Promise<WorkersAiModels> {
	const account = workersAiAccount(settings);
	if (!settings.WORKERS_AI_TOKEN || account === null) {
		return { ok: false, message: WORKERS_AI_NOT_OFFERED };
	}
	const models: ProviderModel[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = new URL(
			`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search`,
		);
		url.searchParams.set("task", "Text Generation");
		url.searchParams.set("per_page", "200");
		if (page > 1) url.searchParams.set("page", String(page));
		let response: Response;
		try {
			response = await fetcher(url, {
				headers: { authorization: `Bearer ${settings.WORKERS_AI_TOKEN}` },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			return { ok: false, message: `Could not reach ${NAME}` };
		}
		if (response.status === 401 || response.status === 403) {
			return { ok: false, message: `${NAME} refused this server's token` };
		}
		if (response.status === 429) {
			return { ok: false, message: `${NAME} is limiting this server's requests; try again later` };
		}
		if (!response.ok) {
			return { ok: false, message: `${NAME} answered with an error (${response.status})` };
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return { ok: false, message: `${NAME} answered with something other than JSON` };
		}
		const found = record(body);
		for (const item of list(found.result)) {
			const model = record(item);
			if (typeof model.name !== "string" || !callsTools(model.properties)) continue;
			models.push({ id: model.name, name: model.name });
		}
		const info = record(found.result_info);
		if (typeof info.total_pages !== "number" || page >= info.total_pages) break;
	}
	return { ok: true, models };
}

/** Whether the model's `function_calling` property says so; Cloudflare writes it as a string. */
function callsTools(properties: unknown): boolean {
	const property = list(properties)
		.map(record)
		.find((candidate) => candidate.property_id === "function_calling");
	return property?.value === "true" || property?.value === true;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
